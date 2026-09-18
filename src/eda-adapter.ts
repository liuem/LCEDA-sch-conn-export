import type { ExportConfig, RawComponent, RawPin, SchSnapshot } from './types.ts';
import { coordKey, DisjointSet, pointOnSegment, wireVertices } from './geometry.ts';
import { mergeNetsByName } from './model.ts';
import { parseProtel2Netlist } from './netlist.ts';
import { DEFAULT_CONFIG } from './types.ts';
/**
 * EDA 运行时适配层 / EDA runtime adapter
 *
 * 职责：
 * - 收集整图快照：全部图页的普通器件（位号/型号/引脚）+ Protel2 网表 + 工程名
 * - 读取选中器件位号（核心器件来源之一；只选引脚时自动反查父器件）
 * - 配置存取、导出内容缓存（预览/复制/下载窗口用；不调用文件系统/联网接口）
 *
 * 只读不写画布；多子部件器件（U1A/U1B）按基准位号聚合为同一器件。
 */

/** 全局 eda 对象由扩展运行时注入 */
declare const eda: any;

const CONFIG_KEY = 'schConnExportConfig';
const LAST_KEY = 'schConnExportLast';
/** 上次导出缓存上限（sys_Storage 不宜塞超长内容，超出则截断预览） */
const LAST_EXPORT_CAP = 400_000;

/* ------------------------- 配置存取 ------------------------- */

export function loadConfig(): ExportConfig {
	let saved = eda.sys_Storage.getExtensionUserConfig(CONFIG_KEY);
	if (typeof saved === 'string' && saved.trim().startsWith('{')) {
		try {
			saved = JSON.parse(saved);
		}
		catch { /* 保持原值 */ }
	}
	const cfg = { ...DEFAULT_CONFIG, ...(saved && typeof saved === 'object' ? saved : {}) };
	cfg.coreDesignators = String(cfg.coreDesignators ?? '');
	cfg.autoDetectCore = !!cfg.autoDetectCore;
	cfg.autoDetectMinPins = Number.isFinite(Number(cfg.autoDetectMinPins)) && cfg.autoDetectMinPins > 0
		? Math.round(Number(cfg.autoDetectMinPins))
		: DEFAULT_CONFIG.autoDetectMinPins;
	cfg.ignorePower = !!cfg.ignorePower;
	cfg.powerByPinName = !!cfg.powerByPinName;
	cfg.showUnconnected = !!cfg.showUnconnected;
	cfg.includeNetSection = !!cfg.includeNetSection;
	cfg.includeComponentsSection = !!cfg.includeComponentsSection;
	cfg.includePowerSummary = !!cfg.includePowerSummary;
	cfg.ignoreNets = String(cfg.ignoreNets ?? DEFAULT_CONFIG.ignoreNets);
	cfg.filePrefix = String(cfg.filePrefix ?? DEFAULT_CONFIG.filePrefix);
	if (cfg.outputStyle !== 'table')
		cfg.outputStyle = 'compact';
	if (cfg.netSectionScope !== 'all')
		cfg.netSectionScope = 'auto';
	cfg.showPinType = !!cfg.showPinType;
	return cfg;
}

export async function saveConfig(cfg: ExportConfig): Promise<boolean> {
	await eda.sys_Storage.setExtensionUserConfig(CONFIG_KEY, JSON.stringify(cfg));
	const back = eda.sys_Storage.getExtensionUserConfig(CONFIG_KEY);
	return typeof back === 'string' && back.includes('"ignoreNets"');
}

/* ------------------------- 画布快照提取 ------------------------- */

/** 剔除装配变量模板占位（如 "={Value}"）：这类字符串不是真实型号/值 */
function cleanModelValue(v: unknown): string {
	const s = String(v ?? '').trim();
	if (!s || /^=\{[^}]*\}$/.test(s) || /^\{[^}]*\}$/.test(s))
		return '';
	return s;
}

/** 依次取第一个非空且非模板占位的值 */
function firstNonEmpty(...vals: Array<unknown>): string {
	for (const v of vals) {
		const s = cleanModelValue(v);
		if (s)
			return s;
	}
	return '';
}

/** 单个器件图元 -> 原始器件数据（多子部件形态：designator 可能带 A/B 后缀） */
async function readComponent(prim: any): Promise<RawComponent | undefined> {
	try {
		const ctype = prim.getState_ComponentType?.();
		if (ctype && ctype !== 'part')
			return undefined; // 网络标号/端口/图框等非普通器件
		const rawDesignator = String(prim.getState_Designator?.() ?? '').trim();
		if (!rawDesignator)
			return undefined;
		const subPart = String(prim.getState_SubPartName?.() ?? '').trim();
		const id = String(prim.getState_PrimitiveId?.() ?? '');
		if (!id)
			return undefined;

		const rawPins = (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(id)) ?? [];
		const pins: RawPin[] = rawPins.map((pin: any) => ({
			pinNumber: String(pin.getState_PinNumber?.() ?? '').trim(),
			pinName: String(pin.getState_PinName?.() ?? '').trim(),
			noConnect: pin.getState_NoConnected?.() === true,
			pinType: String(pin.getState_pinType?.() ?? '').trim() || undefined,
			x: Number.isFinite(Number(pin.getState_X?.())) ? Number(pin.getState_X()) : undefined,
			y: Number.isFinite(Number(pin.getState_Y?.())) ? Number(pin.getState_Y()) : undefined,
		})).filter((pin: RawPin) => pin.pinNumber !== '');

		// 带子部件后缀的位号聚合到基准位号（U1A/U1B -> U1），网表匹配时再按需带后缀
		const designator = subPart ? rawDesignator.replace(new RegExp(`${subPart}$`), '') || rawDesignator : rawDesignator;

		// 型号优先级：制造商编号 > 名称 > 自定义属性 Value/Comment > 库器件名 > 符号名
		// （名称可能只是 "={Value}" 装配变量模板，非真实值，自动跳过）
		const other = prim.getState_OtherProperty?.();
		const otherValue = other
			? firstNonEmpty(other.Value, other.value, other.Comment, other.comment)
			: '';
		// 电阻/电容/电感（R/C/L 开头位号）例外：料号（如 HGC0402R5106M100NTEJ）对理解
		// 电路没有信息量，统一优先显示值（470nF/10k/10uH），值缺失才退回料号链
		const model = /^[RCL]/i.test(designator)
			? firstNonEmpty(
					otherValue,
					prim.getState_Name?.(),
					prim.getState_ManufacturerId?.(),
					prim.getState_Component?.()?.name,
					prim.getState_Symbol?.()?.name,
				)
			: firstNonEmpty(
					prim.getState_ManufacturerId?.(),
					prim.getState_Name?.(),
					otherValue,
					prim.getState_Component?.()?.name,
					prim.getState_Symbol?.()?.name,
				);

		return {
			designator,
			model,
			manufacturer: firstNonEmpty(prim.getState_Manufacturer?.()) || undefined,
			footprint: firstNonEmpty(prim.getState_Footprint?.()?.name) || undefined,
			subParts: subPart ? [subPart] : [],
			pins,
		};
	}
	catch (e) {
		console.warn('[sch-connexport] 读取器件失败:', e);
		return undefined;
	}
}

/** 聚合多子部件：同基准位号合并引脚（按引脚号去重）与子部件名 */
export function aggregateComponents(raw: RawComponent[]): RawComponent[] {
	const order: string[] = [];
	const byKey = new Map<string, RawComponent>();
	for (const comp of raw) {
		const key = comp.designator.toUpperCase();
		const exist = byKey.get(key);
		if (!exist) {
			byKey.set(key, comp);
			order.push(comp.designator);
			continue;
		}
		const seen = new Set(exist.pins.map(p => p.pinNumber));
		for (const p of comp.pins) {
			if (!seen.has(p.pinNumber))
				exist.pins.push(p);
		}
		for (const sp of comp.subParts) {
			if (!exist.subParts.includes(sp))
				exist.subParts.push(sp);
		}
	}
	return order.map(d => byKey.get(d.toUpperCase())!);
}

/**
 * 网表文本多源获取（实测 sch_Netlist.getNetlist 在部分客户端返回空）：
 * 1. `sch_Netlist.getNetlist('Protel2')`（已废弃，可能返回字符串或 File）
 * 2. `sch_ManufactureData.getNetlistFile(name, 'Protel2')`（官方推荐，返回 File）
 * 返回首个能给出非空文本的来源；全失败返回空文本，由调用方告警。
 */
async function fetchNetlistText(): Promise<{ text: string; source: string }> {
	const asText = async (v: unknown): Promise<string> => {
		if (typeof v === 'string')
			return v;
		if (v && typeof (v as any).text === 'function')
			return await (v as any).text();
		if (v != null)
			return String(v);
		return '';
	};

	try {
		const r = await eda.sch_Netlist?.getNetlist?.('Protel2');
		const text = await asText(r);
		if (text.trim())
			return { text, source: 'sch_Netlist.getNetlist' };
		console.warn(`[sch-connexport] sch_Netlist.getNetlist 返回空（类型 ${typeof r}），改用 sch_ManufactureData.getNetlistFile…`);
	}
	catch (e) {
		console.warn('[sch-connexport] sch_Netlist.getNetlist 调用失败，改用 sch_ManufactureData.getNetlistFile…:', e);
	}

	try {
		const f = await eda.sch_ManufactureData?.getNetlistFile?.('sch-conn-export', 'Protel2');
		if (f && typeof (f as any).text === 'function') {
			const text = await (f as any).text();
			if (text.trim())
				return { text, source: 'sch_ManufactureData.getNetlistFile' };
		}
		console.warn(`[sch-connexport] getNetlistFile 未返回可用文件（返回值类型 ${typeof f}）`);
	}
	catch (e) {
		console.warn('[sch-connexport] sch_ManufactureData.getNetlistFile 调用失败:', e);
	}

	return { text: '', source: 'none' };
}

/**
 * 几何法网络重建 / Geometric net extraction
 *
 * 网表接口两路皆空时的第三级数据源（不依赖任何网表 API）：
 * - 读全部导线：`sch_PrimitiveWire.getAll()` → 每条导线的折线坐标 + 网络名（getState_Net）；
 * - 读网络标识（GND/+3V3 电源符号等）：`sch_PrimitiveComponent.getAll('netflag', true)` → 位置 + 网络名；
 * - 引脚坐标来自器件引脚图元（getState_X/Y）；
 * - 并查集聚类：同一导线的折线段连通；引脚/网络标识坐标落在某导线段上即归入该导线簇；
 * - 簇命名优先级：sch_Net 全局网络名（按导线 ID 映射）> 网络标识名 > 导线自带网络名 >
 *   自动名 Net位号_引脚号；一簇出现多个不同名时拼接并在控制台告警（可能存在真实短路）。
 *
 * 已知限制：跨图页坐标空间独立，若 getAll 只覆盖当前页则其它页引脚匹配不上——
 * 控制台输出各环节计数，便于实机诊断。
 */
async function extractGeometricNets(components: RawComponent[]): Promise<SchSnapshot['nets']> {
	interface WireSeg {
		id: string;
		name: string;
		pts: Array<{ x: number; y: number }>;
	}
	const wires: WireSeg[] = [];
	try {
		const prims = (await eda.sch_PrimitiveWire.getAll?.()) ?? [];
		for (const w of prims) {
			try {
				const pts = wireVertices(w.getState_Line?.());
				if (pts.length >= 2)
					wires.push({ id: String(w.getState_PrimitiveId?.() ?? ''), name: String(w.getState_Net?.() ?? '').trim(), pts });
			}
			catch { /* 单条导线读取失败跳过 */ }
		}
	}
	catch (e) {
		console.warn('[sch-connexport] 几何法：导线枚举失败:', e);
	}

	// 权威网络名映射：sch_Net.getCurrentProjectAllNets -> 导线 ID -> globalNetName
	const authNameByWireId = new Map<string, string>();
	try {
		const perSch = (await eda.sch_Net?.getCurrentProjectAllNets?.()) ?? [];
		for (const sch of perSch) {
			for (const net of sch?.nets ?? []) {
				for (const wire of net?.wires ?? []) {
					const id = String(wire?.id ?? '');
					if (id && !authNameByWireId.has(id))
						authNameByWireId.set(id, String(net?.net ?? wire?.globalNetName ?? '').trim());
				}
			}
		}
	}
	catch (e) {
		console.warn('[sch-connexport] 几何法：sch_Net 全局网络名读取失败（退回导线/标识自带名）:', e);
	}

	// 网络标识（电源/地符号）：位置 + 网络名
	const flags: Array<{ x: number; y: number; net: string }> = [];
	try {
		const flagPrims = (await eda.sch_PrimitiveComponent.getAll?.('netflag', true)) ?? [];
		for (const f of flagPrims) {
			try {
				const net = String(f.getState_Net?.() ?? '').trim();
				const x = Number(f.getState_X?.());
				const y = Number(f.getState_Y?.());
				if (net && Number.isFinite(x) && Number.isFinite(y))
					flags.push({ x, y, net });
			}
			catch { /* ignore */ }
		}
	}
	catch { /* 网络标识读取失败不致命：无名的导线簇用自动名 */ }

	const dsu = new DisjointSet();
	// 展开全部导线段（供点命中测试）
	const segs: Array<{ wire: number; ax: number; ay: number; bx: number; by: number }> = [];
	wires.forEach((w, wi) => {
		const first = coordKey(w.pts[0].x, w.pts[0].y);
		dsu.ensure(first);
		for (let i = 1; i < w.pts.length; i++) {
			const k = coordKey(w.pts[i].x, w.pts[i].y);
			dsu.ensure(k);
			dsu.union(first, k);
			segs.push({ wire: wi, ax: w.pts[i - 1].x, ay: w.pts[i - 1].y, bx: w.pts[i].x, by: w.pts[i].y });
		}
	});

	/** 点命中的导线簇根（沿导线段找，命中即与该导线连通） */
	const hitCluster = (px: number, py: number): string | undefined => {
		for (const sg of segs) {
			if (pointOnSegment(px, py, sg.ax, sg.ay, sg.bx, sg.by)) {
				const w = wires[sg.wire];
				return dsu.find(coordKey(w.pts[0].x, w.pts[0].y));
			}
		}
		return undefined;
	};

	// 引脚归簇
	interface PinHit {
		comp: RawComponent;
		pinNumber: string;
		root: string;
	}
	const pinHits: PinHit[] = [];
	let pinsNoCoord = 0;
	let pinsNoHit = 0;
	for (const comp of components) {
		for (const pin of comp.pins) {
			const px = pin.x;
			const py = pin.y;
			if (typeof px !== 'number' || typeof py !== 'number' || !Number.isFinite(px) || !Number.isFinite(py)) {
				pinsNoCoord++;
				continue;
			}
			const root = hitCluster(px, py);
			if (root === undefined) {
				pinsNoHit++;
				continue;
			}
			pinHits.push({ comp, pinNumber: pin.pinNumber, root });
		}
	}

	// 网络标识归簇（同时贡献命名）
	const flagNamesByRoot = new Map<string, Set<string>>();
	for (const f of flags) {
		const root = hitCluster(f.x, f.y);
		if (root === undefined)
			continue;
		if (!flagNamesByRoot.has(root))
			flagNamesByRoot.set(root, new Set());
		flagNamesByRoot.get(root)!.add(f.net);
	}

	// 簇 -> 网络名（优先级：全局网络名 > 网络标识 > 导线自带名 > 自动名）
	const wireRoots = new Map<string, Set<number>>();
	segs.forEach((sg) => {
		const w = wires[sg.wire];
		const root = dsu.find(coordKey(w.pts[0].x, w.pts[0].y));
		if (!wireRoots.has(root))
			wireRoots.set(root, new Set());
		wireRoots.get(root)!.add(sg.wire);
	});

	const pinsByRoot = new Map<string, PinHit[]>();
	for (const hit of pinHits) {
		if (!pinsByRoot.has(hit.root))
			pinsByRoot.set(hit.root, []);
		pinsByRoot.get(hit.root)!.push(hit);
	}

	const nets: SchSnapshot['nets'] = [];
	let autoNamed = 0;
	for (const [root, hits] of pinsByRoot) {
		const names = new Set<string>();
		for (const wi of wireRoots.get(root) ?? []) {
			const w = wires[wi];
			const auth = authNameByWireId.get(w.id) || w.name;
			if (auth)
				names.add(auth);
		}
		for (const n of flagNamesByRoot.get(root) ?? [])
			names.add(n);
		let name: string;
		if (names.size === 1) {
			name = [...names][0];
		}
		else if (names.size > 1) {
			name = [...names].sort().join('|');
			console.warn(`[sch-connexport] 几何法：一个连接簇出现多个网络名（可能短路或跨页重名）：${name}`);
		}
		else {
			name = `Net${hits[0].comp.designator}_${hits[0].pinNumber}`;
			autoNamed++;
		}
		nets.push({
			name,
			members: hits.map(h => ({ designator: h.comp.designator, pinNumber: h.pinNumber })),
		});
	}

	console.log(
		`[sch-connexport] 几何法统计：导线 ${wires.length} 条（段 ${segs.length}），全局名映射 ${authNameByWireId.size} 条，`
		+ `网络标识 ${flags.length} 个；引脚命中 ${pinHits.length}，无坐标 ${pinsNoCoord}，未命中任何导线 ${pinsNoHit}；`
		+ `重建网络 ${nets.length} 个（自动命名 ${autoNamed}）。若"未命中"异常多，可能导线枚举仅覆盖当前图页。`,
	);
	return nets;
}

/** 收集整图快照：全部图页器件 + 网表 + 工程名（全只读） */
export async function collectSnapshot(): Promise<SchSnapshot & { netlistEmpty: boolean }> {
	let prims: any[] = [];
	try {
		prims = (await eda.sch_PrimitiveComponent.getAll?.('part', true)) ?? [];
		if (!prims.length)
			prims = (await eda.sch_PrimitiveComponent.getAll?.()) ?? [];
	}
	catch {
		try {
			prims = (await eda.sch_PrimitiveComponent.getAll?.()) ?? [];
		}
		catch (e) {
			console.warn('[sch-connexport] 器件枚举失败:', e);
		}
	}

	const raw: RawComponent[] = [];
	for (const prim of prims) {
		const comp = await readComponent(prim);
		if (comp)
			raw.push(comp);
	}
	const components = aggregateComponents(raw).sort((a, b) =>
		a.designator.localeCompare(b.designator, 'en', { numeric: true, sensitivity: 'base' }));

	let nets: SchSnapshot['nets'] = [];
	let netlistEmpty = true;
	let netSource = '';
	const { text, source } = await fetchNetlistText();
	nets = mergeNetsByName(parseProtel2Netlist(text).nets);
	if (nets.length) {
		netSource = source;
	}
	else {
		// 第三级来源：几何法重建（导线坐标+网络名 + 引脚/网络标识坐标，并查集聚类）
		console.warn('[sch-connexport] 网表解析为空，启用几何法网络重建（导线+引脚坐标匹配）…');
		nets = mergeNetsByName(await extractGeometricNets(components));
		netSource = nets.length ? 'geometric' : 'none';
	}
	netlistEmpty = nets.length === 0;
	if (netlistEmpty) {
		console.warn(
			`[sch-connexport] ⚠ 网表为空（来源 ${source}，文本 ${text.length} 字符）——所有引脚将显示为未连接！${
				text.trim()
					? `网表原文前 300 字符（格式可能不受支持，请反馈给开发者）：\n${text.slice(0, 300)}`
					: '两个网表接口都未返回内容。请确认工程已保存且原理图存在导线/网络标签。'}`,
		);
	}
	else {
		console.log(`[sch-connexport] 网络来源 ${netSource}：${nets.length} 个网络${netSource === 'geometric' ? '（几何法重建）' : `，网表文本 ${text.length} 字符`}`);
	}

	let projectName = '';
	try {
		const info = await eda.dmt_Project?.getCurrentProjectInfo?.();
		projectName = String(info?.friendlyName ?? info?.name ?? '') || '';
	}
	catch { /* 工程名仅用于标题，可缺省 */ }

	return { projectName, components, nets, netlistEmpty };
}

/** 选中器件位号（只选引脚时反查父器件） */
export async function getSelectedDesignators(): Promise<string[]> {
	const selected = (await eda.sch_SelectControl.getAllSelectedPrimitives()) ?? [];
	const compPrims: any[] = [];
	const pinPrims: any[] = [];
	for (const p of selected) {
		try {
			const t = p.getState_PrimitiveType?.();
			if (t === 'Component')
				compPrims.push(p);
			else if (t === 'ComponentPin')
				pinPrims.push(p);
		}
		catch { /* ignore */ }
	}

	if (!compPrims.length && pinPrims.length) {
		const pinIds = new Set(pinPrims.map(p => String(p.getState_PrimitiveId?.() ?? '')));
		const all = (await eda.sch_PrimitiveComponent.getAll?.()) ?? [];
		for (const c of all) {
			try {
				const ctype = c.getState_ComponentType?.();
				if (ctype && ctype !== 'part')
					continue;
				const pins = (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(c.getState_PrimitiveId())) ?? [];
				if (pins.some((pin: any) => pinIds.has(String(pin.getState_PrimitiveId?.() ?? ''))))
					compPrims.push(c);
			}
			catch { /* ignore */ }
		}
	}

	const out: string[] = [];
	for (const p of compPrims) {
		try {
			const ctype = p.getState_ComponentType?.();
			if (ctype && ctype !== 'part')
				continue;
			const des = String(p.getState_Designator?.() ?? '').trim();
			if (des && !out.includes(des))
				out.push(des);
		}
		catch { /* ignore */ }
	}
	return out;
}

/* ------------------------- 导出输出 ------------------------- */

/**
 * 缓存上次导出内容（预览/复制/下载窗口读取）；超长截断并打标记。
 *
 * 注意：刻意不使用 sys_FileSystem 等本地文件/联网接口——客户端对 bundle 做
 * 静态扫描，只要引用此类接口就会在安装时提示"外部交互权限默认禁用"。
 * 文件落盘由预览窗口内的浏览器下载（blob + a[download]）完成，无需该权限。
 */
export async function storeLastExport(markdown: string, fileName: string): Promise<boolean> {
	try {
		const body = {
			ts: Date.now(),
			fileName,
			truncated: markdown.length > LAST_EXPORT_CAP,
			markdown: markdown.length > LAST_EXPORT_CAP
				? `${markdown.slice(0, LAST_EXPORT_CAP)}\n\n<!-- 内容超长已截断 -->\n`
				: markdown,
		};
		await eda.sys_Storage.setExtensionUserConfig(LAST_KEY, JSON.stringify(body));
		return true;
	}
	catch (e) {
		console.warn('[sch-connexport] 缓存导出内容失败（全文已同时输出到控制台）:', e);
		return false;
	}
}

/** 读取上次导出缓存（预览窗口用） */
export function loadLastExport(): { ts: number; truncated: boolean; fileName?: string; markdown: string } | undefined {
	try {
		const raw = eda.sys_Storage.getExtensionUserConfig(LAST_KEY);
		const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
		if (parsed && typeof parsed === 'object' && typeof parsed.markdown === 'string')
			return { ts: Number(parsed.ts) || 0, truncated: parsed.truncated === true, fileName: typeof parsed.fileName === 'string' ? parsed.fileName : undefined, markdown: parsed.markdown };
	}
	catch { /* ignore */ }
	return undefined;
}
