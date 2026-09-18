import type { PinNetMap } from './netlist.ts';
import type {
	CoreComponent,
	CorePinRow,
	ExportConfig,
	PinRef,
	RawComponent,
	RawNet,
	SchSnapshot,
} from './types.ts';
import { pinKey } from './netlist.ts';
import { POWER_PIN_NAME_PATTERNS } from './types.ts';
/**
 * 连接模型构建 / Connection model
 *
 * 纯逻辑（不依赖 EDA 运行时）：把画布器件快照 + 网表快照合并成
 * 「核心器件引脚表 + 网络分类」模型，供 Markdown 渲染与离线测试。
 *
 * 关键容错：网表里的成员位号与画布位号可能形态不同（多子部件器件
 * U1A/U1B vs 聚合后的 U1），匹配一律"精确优先、剥离子部件后缀兜底"，
 * 匹不上的计入 unmatched 供诊断。
 */

/* ------------------------- 名单 / 模式匹配 ------------------------- */

/** 拆分名单（逗号/分号/换行分隔，去空白，忽略空项） */
export function parseList(text: string): string[] {
	return String(text ?? '')
		.split(/[,;，；\r\n]+/)
		.map(s => s.trim())
		.filter(s => s.length > 0);
}

/** 拆分位号列表（名单分隔符之外也接受空白分隔） */
export function parseDesignatorList(text: string): string[] {
	return String(text ?? '')
		.split(/[,;，；\s]+/)
		.map(s => s.trim())
		.filter(s => s.length > 0);
}

/** 单个通配模式 -> 正则（* 任意串、? 单字符，忽略大小写，整词匹配） */
export function globToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
	return new RegExp(`^${escaped}$`, 'i');
}

export function compilePatterns(patterns: string[]): RegExp[] {
	return patterns.map(globToRegExp);
}

export function matchAny(name: string, compiled: RegExp[]): boolean {
	return compiled.some(re => re.test(name));
}

/** 网络（或引脚名）是否命中内置电源引脚名模式 */
export function isPowerPinName(pinName: string): boolean {
	return matchAny(pinName, compilePatterns(POWER_PIN_NAME_PATTERNS));
}

/** 裸电压形态网络名：3V3 / 1V8 / 1V5 / 1V0 / 12V / 3.3V / +5V（名单之外的第二道规则） */
const VOLTAGE_NET_RE = /^[+-]?\d+(?:\.\d+)?V\d*$/i;

/** 网络名是否应被忽略（电压形态 + 电源名单；ignorePower 关闭时恒 false） */
export function isIgnoredNet(netName: string, cfg: ExportConfig): boolean {
	if (!cfg.ignorePower)
		return false;
	if (VOLTAGE_NET_RE.test(netName.trim()))
		return true;
	return matchAny(netName, compilePatterns(parseList(cfg.ignoreNets)));
}

/**
 * 同名网络合并：网络名的语义就是"同名即同网"（跨区域/跨图页靠标签同名连接）。
 * 几何法按导线簇重建时，两片互不相连但同名标签的导线会成为两个网络——
 * 合并后核心表对端与电源汇总才完整（成员去重）。
 */
export function mergeNetsByName(nets: RawNet[]): RawNet[] {
	const merged = new Map<string, RawNet>();
	for (const n of nets) {
		const exist = merged.get(n.name);
		if (!exist) {
			merged.set(n.name, { name: n.name, members: [...n.members] });
			continue;
		}
		for (const m of n.members) {
			if (!exist.members.some(x => x.designator === m.designator && x.pinNumber === m.pinNumber))
				exist.members.push(m);
		}
	}
	return [...merged.values()];
}

/* ------------------------- 位号工具 ------------------------- */

/** 去掉可能的多子部件后缀：U1A -> U1、RN3B -> RN3（末位为字母且其前不为字母） */
export function baseDesignator(designator: string): string {
	const m = designator.match(/^(.*?\d)[A-Z]$/i);
	return m ? m[1] : designator;
}

/** 自然排序（数字段按数值：PIN2 < PIN10） */
export function naturalCompare(a: string, b: string): number {
	const sa = String(a ?? '').split(/(\d+)/);
	const sb = String(b ?? '').split(/(\d+)/);
	for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
		const x = sa[i];
		const y = sb[i];
		if (x === undefined)
			return -1;
		if (y === undefined)
			return 1;
		if (i % 2 === 1) {
			const nx = Number(x);
			const ny = Number(y);
			if (nx !== ny)
				return nx - ny;
		}
		else if (x.localeCompare(y, 'en', { sensitivity: 'base' }) !== 0) {
			return x.localeCompare(y, 'en', { sensitivity: 'base' });
		}
	}
	return 0;
}

/* ------------------------- 核心器件解析 ------------------------- */

export interface CoreResolution {
	/** 解析出的核心器件（按位号自然排序） */
	cores: RawComponent[];
	/** 想要但没找到的位号 */
	missing: string[];
	/** 是否启用了自动识别 */
	autoUsed: boolean;
}

/**
 * 核心器件 = 画布选中的位号 ∪ 配置位号；都没有且开了自动识别时，
 * 取引脚数 ≥ minPins 的器件。位号匹配忽略大小写。
 */
export function resolveCores(snapshot: SchSnapshot, cfg: ExportConfig, selectedDesignators: string[]): CoreResolution {
	const wanted = new Map<string, string>();
	for (const d of [...selectedDesignators, ...parseDesignatorList(cfg.coreDesignators)])
		wanted.set(d.toUpperCase(), d);

	const byUpper = new Map<string, RawComponent>();
	for (const c of snapshot.components)
		byUpper.set(c.designator.toUpperCase(), c);

	const cores: RawComponent[] = [];
	const missing: string[] = [];
	for (const [upper, raw] of wanted) {
		const hit = byUpper.get(upper);
		if (hit)
			cores.push(hit);
		else
			missing.push(raw);
	}

	let autoUsed = false;
	if (!cores.length && cfg.autoDetectCore) {
		autoUsed = true;
		const min = Number.isFinite(cfg.autoDetectMinPins) ? cfg.autoDetectMinPins : 24;
		cores.push(...snapshot.components.filter(c => c.pins.length >= min));
	}
	cores.sort((a, b) => naturalCompare(a.designator, b.designator));
	return { cores, missing, autoUsed };
}

/* ------------------------- 连接模型 ------------------------- */

export interface NetIndex {
	/** 网络名 -> 网络 */
	byName: Map<string, RawNet>;
	/** 分类：网络名 -> 是否被忽略（电源等） */
	ignored: Map<string, boolean>;
	/** 引脚 -> 网络（网表原始键） */
	pinNets: PinNetMap;
	/** 网表成员位号 -> 画布器件（解析失败不计入） */
	memberComp: Map<string, RawComponent>;
	/** 网表成员没匹配到画布器件的明细（`位号-引脚号@网络`） */
	unmatched: string[];
}

/** 位号（含子部件形态）到聚合器件的索引：精确形态 + 基准形态都指向同一器件 */
function buildDesignatorIndex(components: RawComponent[]): Map<string, RawComponent> {
	const idx = new Map<string, RawComponent>();
	const put = (key: string, comp: RawComponent) => {
		const k = key.toUpperCase();
		if (!idx.has(k))
			idx.set(k, comp);
	};
	for (const c of components) {
		put(c.designator, c);
		put(baseDesignator(c.designator), c);
		for (const sp of c.subParts)
			put(`${c.designator}${sp}`, c);
	}
	return idx;
}

/** 在网表引脚索引里查引脚网络：精确位号 → 基准位号 → 位号+子部件，全形态尝试 */
function findNet(pinNets: PinNetMap, comp: RawComponent, pinNumber: string): string | undefined {
	const candidates = [comp.designator, baseDesignator(comp.designator), ...comp.subParts.map(sp => `${comp.designator}${sp}`)];
	for (const des of candidates) {
		const net = pinNets.get(pinKey(des, pinNumber));
		if (net !== undefined)
			return net;
	}
	return undefined;
}

export function buildNetIndex(snapshot: SchSnapshot, cfg: ExportConfig): NetIndex {
	const byName = new Map<string, RawNet>();
	for (const n of snapshot.nets) {
		if (!byName.has(n.name))
			byName.set(n.name, n);
	}

	const pinNets: PinNetMap = new Map();
	for (const n of snapshot.nets) {
		for (const m of n.members)
			pinNets.set(pinKey(m.designator, m.pinNumber), n.name);
	}

	const desIdx = buildDesignatorIndex(snapshot.components);
	const memberComp = new Map<string, RawComponent>();
	const unmatched: string[] = [];
	for (const n of snapshot.nets) {
		for (const m of n.members) {
			const key = m.designator.toUpperCase();
			let comp = desIdx.get(key);
			if (!comp) {
				const base = baseDesignator(m.designator).toUpperCase();
				comp = desIdx.get(base);
			}
			if (comp)
				memberComp.set(`${m.designator}\u0001${m.pinNumber}`, comp);
			else
				unmatched.push(`${m.designator}-${m.pinNumber}@${n.name}`);
		}
	}

	// 分类：网络名命中名单 -> 电源；否则（powerByPinName 开时）全部成员都解析为
	// 电源引脚名的网络（自定义电源轨，如 MY_RAIL 上只有 VDDIO 脚）也归为电源
	const ignored = new Map<string, boolean>();
	for (const [name, net] of byName) {
		let isPower = isIgnoredNet(name, cfg);
		if (!isPower && cfg.ignorePower && cfg.powerByPinName && net.members.length) {
			isPower = net.members.every((m) => {
				const comp = memberComp.get(`${m.designator}\u0001${m.pinNumber}`);
				const pin = comp?.pins.find(p => p.pinNumber === m.pinNumber);
				return !!pin && isPowerPinName(pin.pinName);
			});
		}
		ignored.set(name, isPower);
	}
	return { byName, ignored, pinNets, memberComp, unmatched };
}

/** 连接点显示：位号.引脚名(引脚号)；引脚名缺失或与引脚号相同则只写 位号.引脚号 */
export function pinRefLabel(ref: PinRef): string {
	const name = ref.pinName && ref.pinName !== ref.pinNumber ? ref.pinName : ref.pinNumber;
	return ref.pinName && ref.pinName !== ref.pinNumber
		? `${ref.designator}.${name}(${ref.pinNumber})`
		: `${ref.designator}.${name}`;
}

/** 引脚电气类型缩写：I/O/IO/P/G；无方向意义（Passive/Undefined/未设）返回空 */
export function pinTypeShort(pinType?: string): string {
	switch (String(pinType ?? '')) {
		case 'IN': return 'I';
		case 'OUT': return 'O';
		case 'BI': return 'IO';
		case 'Power': return 'P';
		case 'Ground': return 'G';
		default: return '';
	}
}

/** 核心器件涉及的网络名集合（任一核心引脚所在网络，含电源） */
export function netsTouchingCores(cores: CoreComponent[]): Set<string> {
	const set = new Set<string>();
	for (const c of cores) {
		for (const p of c.pins) {
			if (p.net !== undefined)
				set.add(p.net);
		}
	}
	return set;
}

/** 网络成员 -> 连接点引用（能解析到器件时带上引脚名） */
function memberToRef(member: { designator: string; pinNumber: string }, idx: NetIndex): PinRef {
	const comp = idx.memberComp.get(`${member.designator}\u0001${member.pinNumber}`);
	const pin = comp?.pins.find(p => p.pinNumber === member.pinNumber);
	return {
		designator: member.designator,
		pinNumber: member.pinNumber,
		pinName: pin?.pinName ?? '',
	};
}

/** 核心器件引脚行构建（分类 + 对端连接点） */
export function buildCorePinRows(comp: RawComponent, idx: NetIndex, cfg: ExportConfig): CorePinRow[] {
	// 自身位号的所有形态（基准/带子部件后缀），用于在对端列表里排除自己
	const selfForms = new Set<string>();
	for (const des of [comp.designator, baseDesignator(comp.designator), ...comp.subParts.map(sp => `${comp.designator}${sp}`)])
		selfForms.add(des.toUpperCase());

	return comp.pins.map((pin) => {
		const net = findNet(idx.pinNets, comp, pin.pinNumber);
		let cls: CorePinRow['cls'] = 'unconnected';
		let peers: PinRef[] = [];
		if (net !== undefined) {
			const raw = idx.byName.get(net);
			const netIgnored = idx.ignored.get(net) ?? isIgnoredNet(net, cfg);
			const pinPower = cfg.powerByPinName && isPowerPinName(pin.pinName);
			cls = netIgnored || pinPower ? 'power' : 'signal';
			if (raw && cls !== 'power') {
				peers = raw.members
					.filter(m => !(selfForms.has(m.designator.toUpperCase()) && m.pinNumber === pin.pinNumber))
					.map(m => memberToRef(m, idx));
				peers.sort((a, b) => naturalCompare(a.designator, b.designator) || naturalCompare(a.pinNumber, b.pinNumber));
			}
		}
		return { pinNumber: pin.pinNumber, pinName: pin.pinName, net, cls, noConnect: pin.noConnect, pinType: pin.pinType, peers };
	});
}

/** 核心器件渲染单元列表 */
export function buildCoreComponents(cores: RawComponent[], idx: NetIndex, cfg: ExportConfig): CoreComponent[] {
	return cores.map(comp => ({
		designator: comp.designator,
		model: comp.model,
		manufacturer: comp.manufacturer,
		footprint: comp.footprint,
		pins: buildCorePinRows(comp, idx, cfg),
	}));
}

/** 器件信号连接（其它器件一览用：引脚 -> 未被忽略的网络） */
export interface CompPinNet {
	pinNumber: string;
	pinName: string;
	net: string;
}

/** 枚举器件的全部信号连接（电源/被忽略网络与未连接引脚不计入） */
export function componentSignalPins(comp: RawComponent, idx: NetIndex, cfg: ExportConfig): CompPinNet[] {
	const out: CompPinNet[] = [];
	for (const pin of comp.pins) {
		const net = findNet(idx.pinNets, comp, pin.pinNumber);
		if (net === undefined)
			continue;
		if (idx.ignored.get(net) ?? isIgnoredNet(net, cfg))
			continue;
		if (cfg.powerByPinName && isPowerPinName(pin.pinName))
			continue;
		out.push({ pinNumber: pin.pinNumber, pinName: pin.pinName, net });
	}
	out.sort((a, b) => naturalCompare(a.pinNumber, b.pinNumber));
	return out;
}

/* ------------------------- 统计 ------------------------- */

export interface ModelStats {
	netCount: number;
	signalNetCount: number;
	powerNetCount: number;
	unmatchedMembers: number;
}

export function netStats(idx: NetIndex): ModelStats {
	let signal = 0;
	let power = 0;
	for (const ignored of idx.ignored.values())
		ignored ? power++ : signal++;
	return { netCount: idx.byName.size, signalNetCount: signal, powerNetCount: power, unmatchedMembers: idx.unmatched.length };
}

/** 信号网络（未被忽略）列表，按名称自然排序 */
export function signalNets(idx: NetIndex): RawNet[] {
	return [...idx.byName.values()].filter(n => !(idx.ignored.get(n.name) ?? false)).sort((a, b) => naturalCompare(a.name, b.name));
}

/** 被忽略（电源等）网络列表，按名称自然排序 */
export function powerNets(idx: NetIndex): RawNet[] {
	return [...idx.byName.values()].filter(n => idx.ignored.get(n.name) ?? false).sort((a, b) => naturalCompare(a.name, b.name));
}
