import type { NetIndex } from './model.ts';
import type {
	CoreComponent,
	CorePinRow,
	ExportConfig,
	ExportStats,
	RenderedDoc,
	RenderedSelectionDoc,
	SchSnapshot,
	SelectionStats,
} from './types.ts';
import {
	componentSignalPins,
	naturalCompare,
	netsTouchingCores,
	pinRefLabel,
	pinTypeShort,
	powerNets,
	signalNets,
} from './model.ts';
/**
 * Markdown 渲染 / Markdown renderer
 *
 * 面向"非多模态大模型"的文档（纯逻辑，可离线测试），信息密度优先：
 * 1. 核心器件：每个 MCU/FPGA/DSP 的「引脚号 引脚名 网络 = 对端 位号.引脚名(引脚号)」
 *    逐行清单，电源脚与未连接脚压成单行说明——LLM 固件问答最常用视角；
 * 2. 信号网络：默认只列**不经过核心器件**的网络（核心相关网络已在核心表完整展开，
 *    避免重复消耗 token），可在设置改为全量；
 * 3. 其它器件一览：位号 + 型号/值 + 各引脚信号网络——元件为中心的全景；
 * 4. 已忽略电源网络汇总：被滤掉的电源/地可追溯。
 *
 * 两种输出风格（设置可切换）：
 * - compact（默认）：核心表用 ```text 代码块逐行输出，无表格分隔线开销；
 * - table：传统 Markdown 表格，人读更友好。
 */

/** 表格单元格转义：竖线与换行 */
function cell(text: string): string {
	return String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/** 本地时间 YYYY-MM-DD HH:mm（避免 toISOString 的时区偏移） */
export function formatTimestamp(now: Date): string {
	return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

export function defaultFileName(cfg: ExportConfig, now: Date, tag = ''): string {
	const prefix = (cfg.filePrefix || 'schematic-connections').replace(/[\\/:*?"<>|]/g, '');
	return `${prefix}${tag ? `-${tag}` : ''}-${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}.md`;
}

const POWER_MEMBER_CAP = 24;

/** 网表成员 -> 连接点引用（能解析到器件时带上引脚名），按位号+引脚号排序保证输出稳定 */
function memberRefs(net: { members: Array<{ designator: string; pinNumber: string }> }, idx: NetIndex): string[] {
	const refs = net.members.map((m) => {
		const comp = idx.memberComp.get(`${m.designator}\u0001${m.pinNumber}`);
		const pin = comp?.pins.find(p => p.pinNumber === m.pinNumber);
		return { designator: m.designator, pinNumber: m.pinNumber, pinName: pin?.pinName ?? '' };
	});
	refs.sort((a, b) => naturalCompare(a.designator, b.designator) || naturalCompare(a.pinNumber, b.pinNumber));
	return refs.map(pinRefLabel);
}

/** 核心器件引脚名（可带电气方向后缀） */
function corePinName(p: { pinName: string; pinType?: string }, cfg: ExportConfig): string {
	const dir = cfg.showPinType ? pinTypeShort(p.pinType) : '';
	return dir ? `${p.pinName || '?'}[${dir}]` : (p.pinName || '?');
}

/** 未连接引脚的单行明细（紧凑形式：`1 VBAT`、`3 PC14(NoERC)`） */
function unconnectedCompact(p: { pinNumber: string; pinName: string; noConnect: boolean }): string {
	return `${p.pinNumber} ${p.pinName || '?'}${p.noConnect ? '(NoERC)' : ''}`;
}

/** 电源引脚的单行明细（引脚名与引脚号相同只写一处，如 TVS 的 3/8） */
function powerCompact(p: { pinNumber: string; pinName: string; net?: string }): string {
	const name = p.pinName || p.net || '?';
	return name === p.pinNumber ? p.pinNumber : `${p.pinNumber} ${name}`;
}

/** 渲染主入口 */
export function renderMarkdown(
	snapshot: SchSnapshot,
	cfg: ExportConfig,
	cores: CoreComponent[],
	idx: NetIndex,
	opts: { now?: Date } = {},
): RenderedDoc {
	const now = opts.now ?? new Date();
	const title = snapshot.projectName || '当前工程';
	const compact = cfg.outputStyle !== 'table';
	const allSignalNets = signalNets(idx);
	const pwrNets = powerNets(idx);
	const coreNets = netsTouchingCores(cores);
	const shownNets = cfg.netSectionScope === 'all'
		? allSignalNets
		: allSignalNets.filter(n => !coreNets.has(n.name));

	let coreSignalPins = 0;
	let corePowerPins = 0;
	let coreUnconnectedPins = 0;
	for (const c of cores) {
		for (const p of c.pins) {
			if (p.cls === 'signal')
				coreSignalPins++;
			else if (p.cls === 'power')
				corePowerPins++;
			else
				coreUnconnectedPins++;
		}
	}

	const stats: ExportStats = {
		componentCount: snapshot.components.length,
		coreCount: cores.length,
		netCount: idx.byName.size,
		signalNetCount: allSignalNets.length,
		powerNetCount: pwrNets.length,
		coreSignalPins,
		corePowerPins,
		coreUnconnectedPins,
		unmatchedMembers: idx.unmatched.length,
	};

	const L: string[] = [];
	L.push(`# 电路连接导出：${title}`);
	L.push('');
	L.push(`> 嘉立创EDA专业版扩展「原理图连接信息导出」· ${formatTimestamp(now)} · 器件 ${stats.componentCount}（核心 ${stats.coreCount}）· 网络 ${stats.netCount}（信号 ${stats.signalNetCount} + 电源 ${stats.powerNetCount}${cfg.ignorePower ? '，已忽略' : '，保留'}）`);
	L.push(`> 记法：连接点 = 位号.引脚名(引脚号)（引脚名与引脚号相同只写一处，如 R4.1）；核心表每行 = 引脚号 引脚名 网络 = 对端列表，"-" 表示该网络上没有其它器件。${cfg.showPinType ? '引脚名后方括号为电气方向 [I]/[O]/[IO]/[P]/[G]。' : ''}`);
	if (!idx.byName.size && snapshot.components.length) {
		L.push('> ⚠ **网表读取为空：以下全部引脚显示的"未连接"不代表真实电路！** 网表接口与几何法重建（导线+引脚坐标）都未能获得网络连接（详见 EDA 控制台，过滤 sch-connexport）。请确认工程已保存后重试，并把控制台诊断反馈给开发者。');
	}
	L.push('');

	/* ---------------- 1. 核心器件 ---------------- */
	L.push('## 1. 核心器件（需编写程序的器件）');
	L.push('');
	if (!cores.length) {
		L.push('（未指定核心器件——在原理图选中 MCU/FPGA 后运行，或在设置里配置位号。）');
	}
	for (const core of cores) {
		const meta = [core.manufacturer, core.footprint].filter(Boolean).join(' / ');
		L.push(`### ${core.designator}${core.model ? ` — ${core.model}` : ''}${meta ? `（${meta}）` : ''}`);
		L.push('');
		L.push(`共 ${core.pins.length} 引脚：信号 ${core.pins.filter(p => p.cls === 'signal').length} · 电源 ${core.pins.filter(p => p.cls === 'power').length}（${cfg.ignorePower ? '已忽略' : '保留'}）· 未连接 ${core.pins.filter(p => p.cls === 'unconnected').length}`);
		L.push('');
		const sorted = [...core.pins].sort((a, b) => naturalCompare(a.pinNumber, b.pinNumber));
		const signals = sorted.filter(p => p.cls === 'signal');

		if (compact) {
			L.push('```text');
			for (const p of signals)
				L.push(`${p.pinNumber} ${corePinName(p, cfg)} ${p.net ?? ''} = ${p.peers.length ? p.peers.map(pinRefLabel).join(', ') : '-'}`);
			L.push('```');
		}
		else {
			L.push('| 引脚号 | 引脚名 | 网络 | 连接到 |');
			L.push('| --- | --- | --- | --- |');
			for (const p of signals)
				L.push(`| ${cell(p.pinNumber)} | ${cell(corePinName(p, cfg))} | ${cell(p.net ?? '')} | ${cell(p.peers.map(pinRefLabel).join(', '))} |`);
		}
		L.push('');
		if (cfg.showUnconnected) {
			const un = sorted.filter(p => p.cls === 'unconnected');
			if (un.length) {
				L.push(compact
					? `未连接（${un.length}）：${un.map(unconnectedCompact).join('，')}`
					: `未连接引脚（${un.length}）：${un.map(p => `${p.pinNumber} (${corePinName(p, cfg)}${p.noConnect ? '，No ERC' : ''})`).join('、')}`);
				L.push('');
			}
		}
		const pw = sorted.filter(p => p.cls === 'power');
		if (pw.length) {
			L.push(compact
				? `电源（${cfg.ignorePower ? '已忽略' : '按引脚名归类'}，${pw.length}）：${pw.map(powerCompact).join('，')}`
				: `电源/地引脚（${cfg.ignorePower ? '已忽略' : '已按引脚名归类'}，${pw.length}）：${pw.map(p => `${p.pinNumber} (${corePinName(p, cfg) || p.net || '?'})`).join('、')}`);
			L.push('');
		}
	}

	/* ---------------- 2. 信号网络 ---------------- */
	if (cfg.includeNetSection) {
		const header = cfg.netSectionScope === 'all'
			? `## 2. 信号网络总表（${shownNets.length} 个）`
			: `## 2. 不经过核心器件的信号网络（${shownNets.length} 个，核心相关网络已完整列在各核心器件表中）`;
		L.push(header);
		L.push('');
		if (!shownNets.length) {
			L.push('（没有这类网络——所有信号网络都经过核心器件，或已被忽略名单滤除。）');
		}
		else if (compact) {
			L.push('```text');
			for (const net of shownNets)
				L.push(`${net.name}: ${memberRefs(net, idx).join(', ')}`);
			L.push('```');
		}
		else {
			L.push('| 网络 | 连接点 |');
			L.push('| --- | --- |');
			for (const net of shownNets)
				L.push(`| ${cell(net.name)} | ${cell(memberRefs(net, idx).join(', '))} |`);
		}
		L.push('');
	}

	/* ---------------- 3. 其它器件一览 ---------------- */
	if (cfg.includeComponentsSection) {
		const coreSet = new Set(cores.map(c => c.designator.toUpperCase()));
		const others = snapshot.components
			.filter(c => !coreSet.has(c.designator.toUpperCase()))
			.sort((a, b) => naturalCompare(a.designator, b.designator));
		L.push(`## 3. 其它器件一览（${others.length} 个）`);
		L.push('');
		if (!others.length) {
			L.push('（除核心器件外没有其它器件。）');
		}
		else if (compact) {
			L.push('```text');
			for (const comp of others) {
				const sigs = componentSignalPins(comp, idx, cfg)
					.map(s => `${s.pinName && s.pinName !== s.pinNumber ? `${s.pinName}(${s.pinNumber})` : s.pinNumber}=${s.net}`);
				L.push(`${comp.designator} ${comp.model || '?'}${sigs.length ? `: ${sigs.join(' ')}` : ''}`);
			}
			L.push('```');
		}
		else {
			L.push('| 位号 | 型号/值 | 信号连接（引脚名:网络） |');
			L.push('| --- | --- | --- |');
			for (const comp of others) {
				const sigs = componentSignalPins(comp, idx, cfg)
					.map(s => `${s.pinName && s.pinName !== s.pinNumber ? s.pinName : s.pinNumber}:${s.net}`);
				L.push(`| ${cell(comp.designator)} | ${cell(comp.model || '?')} | ${cell(sigs.join(', '))} |`);
			}
		}
		L.push('');
	}

	/* ---------------- 4. 已忽略的电源网络 ---------------- */
	if (cfg.includePowerSummary && cfg.ignorePower) {
		L.push(`## 4. 已忽略的电源/地网络（${pwrNets.length} 个）`);
		L.push('');
		if (!pwrNets.length) {
			L.push('（没有命中忽略名单的网络。）');
		}
		else if (compact) {
			L.push('```text');
			for (const net of pwrNets) {
				const refs = memberRefs(net, idx);
				L.push(`${net.name}(${refs.length}): ${refs.length > POWER_MEMBER_CAP ? `${refs.slice(0, POWER_MEMBER_CAP).join(', ')} …` : refs.join(', ')}`);
			}
			L.push('```');
		}
		else {
			L.push('| 网络 | 连接点 |');
			L.push('| --- | --- |');
			for (const net of pwrNets) {
				let refs = memberRefs(net, idx);
				if (refs.length > POWER_MEMBER_CAP) {
					const total = refs.length;
					refs = refs.slice(0, POWER_MEMBER_CAP);
					refs.push(`…共 ${total} 处`);
				}
				L.push(`| ${cell(net.name)} | ${cell(refs.join(', '))} |`);
			}
		}
		L.push('');
		L.push('（忽略名单可在插件「设置面板」中调整；关闭「忽略电源/地网络」可在正文完整保留它们。）');
	}

	// --- 前必须空一行，否则上一行文字会被解析成 Setext 标题
	if (L[L.length - 1] !== '')
		L.push('');
	L.push('---');
	L.push('');
	L.push(`*导出于 ${formatTimestamp(now)} · 原理图连接信息导出（lceda-sch-conn-export）*`);

	return { markdown: `${L.join('\n')}\n`, stats, unmatched: idx.unmatched };
}

/** 汇总文本（结果对话框用） */
export function summaryText(stats: ExportStats): string {
	return [
		`器件 ${stats.componentCount} 个（核心 ${stats.coreCount} 个）`,
		`网络 ${stats.netCount} 个：信号 ${stats.signalNetCount}，电源/忽略 ${stats.powerNetCount}`,
		`核心器件引脚：信号 ${stats.coreSignalPins}，电源 ${stats.corePowerPins}，未连接 ${stats.coreUnconnectedPins}`,
		stats.unmatchedMembers
			? `⚠ ${stats.unmatchedMembers} 个网表连接点未匹配到画布器件（可能为多子部件/特殊位号，明细见控制台诊断）`
			: '全部网表连接点均成功匹配画布器件',
	].join('\n');
}

/* ---------------- 模块视图（选中器件互联） ---------------- */

/**
 * 模块视图渲染：只围绕画布选中的器件（≥2 个）输出——
 * 1. 选定器件清单（型号/引脚数）；
 * 2. 器件间互联网络：连接 ≥2 个选中器件的信号网络，逐网络列出选中侧
 *    连接点（"=" 连接）与未选中侧连接点（"，外部："），逐模块开发时
 *    只看这一张表就能写对引脚级互联；
 * 3. 对外信号引脚：模块边界（网络只连到本模块一处的引脚 + 模块外去向）；
 * 4. 电源/未连接汇总（电源脚明细 + 未连接计数）。
 * 电源忽略等配置与全图导出共用；全图相关的章节开关对本视图不适用。
 */
export function renderSelectionMarkdown(
	snapshot: SchSnapshot,
	cfg: ExportConfig,
	cores: CoreComponent[],
	idx: NetIndex,
	opts: { now?: Date } = {},
): RenderedSelectionDoc {
	const now = opts.now ?? new Date();
	const title = snapshot.projectName || '当前工程';
	const compact = cfg.outputStyle !== 'table';
	const selKeys = new Set(cores.map(c => c.designator.toUpperCase()));

	// 网络 -> 触及的选中器件集合（按解析后的聚合位号，多子部件 U2A/U2B 归同一器件）
	const netSelComps = new Map<string, Set<string>>();
	for (const net of idx.byName.values()) {
		const set = new Set<string>();
		for (const m of net.members) {
			const comp = idx.memberComp.get(`${m.designator}\u0001${m.pinNumber}`);
			const key = comp?.designator.toUpperCase();
			if (key && selKeys.has(key))
				set.add(key);
		}
		netSelComps.set(net.name, set);
	}

	const interconnects = [...idx.byName.values()]
		.filter(n => !(idx.ignored.get(n.name) ?? false) && (netSelComps.get(n.name)?.size ?? 0) >= 2)
		.sort((a, b) => naturalCompare(a.name, b.name));

	const boundary: Array<{ core: CoreComponent; row: CorePinRow }> = [];
	let powerPins = 0;
	let unconnectedPins = 0;
	for (const core of cores) {
		for (const p of core.pins) {
			if (p.cls === 'signal' && p.net !== undefined) {
				if ((netSelComps.get(p.net)?.size ?? 0) >= 2)
					continue; // 已在互联网络表展开
				boundary.push({ core, row: p });
			}
			else if (p.cls === 'power') {
				powerPins++;
			}
			else {
				unconnectedPins++;
			}
		}
	}
	boundary.sort((a, b) =>
		naturalCompare(a.core.designator, b.core.designator) || naturalCompare(a.row.pinNumber, b.row.pinNumber));

	const stats: SelectionStats = {
		selectedCount: cores.length,
		interconnectCount: interconnects.length,
		boundaryCount: boundary.length,
		powerPinCount: powerPins,
		unconnectedPinCount: unconnectedPins,
		unmatchedMembers: idx.unmatched.length,
	};

	const L: string[] = [];
	L.push(`# 模块连接导出：${title}（选中 ${cores.length} 个器件）`);
	L.push('');
	L.push(`> 嘉立创EDA专业版扩展「原理图连接信息导出」· ${formatTimestamp(now)} · 互联网络 ${stats.interconnectCount} · 对外信号引脚 ${stats.boundaryCount} · 电源脚 ${stats.powerPinCount}${cfg.ignorePower ? '（已忽略）' : ''} · 未连接 ${stats.unconnectedPinCount}`);
	L.push(`> 记法：连接点 = 位号.引脚名(引脚号)（引脚名与引脚号相同只写一处，如 R4.1）；互联行 = "网络: 连接点 = 连接点"（同一网络），"，外部：" 后为未选中器件的连接点。${cfg.showPinType ? '连接点后方括号为电气方向 [I]/[O]/[IO]/[P]/[G]。' : ''}`);
	if (!idx.byName.size && snapshot.components.length) {
		L.push('> ⚠ **网表读取为空：以下全部引脚显示的"未连接"不代表真实电路！** 网表接口与几何法重建（导线+引脚坐标）都未能获得网络连接（详见 EDA 控制台，过滤 sch-connexport）。请确认工程已保存后重试，并把控制台诊断反馈给开发者。');
	}
	L.push('');

	/* ---------------- 1. 选定器件 ---------------- */
	L.push(`## 1. 选定器件（${cores.length} 个）`);
	L.push('');
	if (!cores.length) {
		L.push('（未选中器件。）');
	}
	else if (compact) {
		L.push('```text');
		for (const core of cores) {
			const meta = [core.manufacturer, core.footprint].filter(Boolean).join(' / ');
			L.push(`${core.designator} ${core.model || '?'}${meta ? `（${meta}）` : ''} · ${core.pins.length} 脚`);
		}
		L.push('```');
	}
	else {
		L.push('| 位号 | 型号/值 | 制造商/封装 | 引脚数 |');
		L.push('| --- | --- | --- | --- |');
		for (const core of cores) {
			const meta = [core.manufacturer, core.footprint].filter(Boolean).join(' / ');
			L.push(`| ${cell(core.designator)} | ${cell(core.model || '?')} | ${cell(meta)} | ${core.pins.length} |`);
		}
	}
	L.push('');

	/* ---------------- 2. 器件间互联网络 ---------------- */
	L.push(`## 2. 器件间互联网络（${interconnects.length} 个）`);
	L.push('');
	if (!interconnects.length) {
		L.push('（选定器件之间没有直接相连的信号网络——电源/地不在此列。）');
	}
	else if (compact) {
		L.push('```text');
		for (const net of interconnects) {
			const tags = memberTagLabels(net, idx, cfg, selKeys);
			const sel = tags.filter(t => t.selected).map(t => t.label);
			const ext = tags.filter(t => !t.selected).map(t => t.label);
			L.push(`${net.name}: ${sel.join(' = ')}${ext.length ? `，外部：${ext.join(', ')}` : ''}`);
		}
		L.push('```');
	}
	else {
		L.push('| 网络 | 选定器件连接点 | 外部连接点 |');
		L.push('| --- | --- | --- |');
		for (const net of interconnects) {
			const tags = memberTagLabels(net, idx, cfg, selKeys);
			const sel = tags.filter(t => t.selected).map(t => t.label);
			const ext = tags.filter(t => !t.selected).map(t => t.label);
			L.push(`| ${cell(net.name)} | ${cell(sel.join(' = '))} | ${cell(ext.join(', '))} |`);
		}
	}
	L.push('');

	/* ---------------- 3. 对外信号引脚 ---------------- */
	L.push(`## 3. 对外信号引脚（${boundary.length} 个，网络只触及本模块一处）`);
	L.push('');
	if (!boundary.length) {
		L.push('（没有对外信号引脚。）');
	}
	else if (compact) {
		L.push('```text');
		for (const b of boundary) {
			const ref = coreRefLabel(b.core, b.row, cfg);
			L.push(`${ref} ${b.row.net ?? ''} = ${b.row.peers.length ? b.row.peers.map(pinRefLabel).join(', ') : '-'}`);
		}
		L.push('```');
	}
	else {
		L.push('| 连接点 | 网络 | 外部连接点 |');
		L.push('| --- | --- | --- |');
		for (const b of boundary) {
			const ref = coreRefLabel(b.core, b.row, cfg);
			L.push(`| ${cell(ref)} | ${cell(b.row.net ?? '')} | ${cell(b.row.peers.map(pinRefLabel).join(', '))} |`);
		}
	}
	L.push('');

	/* ---------------- 4. 电源与未连接汇总 ---------------- */
	const summaryLines: string[] = [];
	for (const core of cores) {
		const sorted = [...core.pins].sort((a, b) => naturalCompare(a.pinNumber, b.pinNumber));
		const pw = sorted.filter(p => p.cls === 'power');
		const un = sorted.filter(p => p.cls === 'unconnected');
		if (!pw.length && !(cfg.showUnconnected && un.length))
			continue;
		const parts: string[] = [];
		if (pw.length)
			parts.push(`电源/地 ${pw.length}${cfg.ignorePower ? '（已忽略）' : ''}：${pw.map(powerCompact).join('，')}`);
		if (cfg.showUnconnected && un.length)
			parts.push(`未连接 ${un.length}`);
		summaryLines.push(`${core.designator}：${parts.join(' · ')}`);
	}
	if (summaryLines.length) {
		L.push(`## 4. 电源与未连接（汇总）`);
		L.push('');
		L.push(compact ? summaryLines.join('\n') : summaryLines.map(s => `- ${s}`).join('\n'));
		L.push('');
	}

	// --- 前必须空一行，否则上一行文字会被解析成 Setext 标题
	if (L[L.length - 1] !== '')
		L.push('');
	L.push('---');
	L.push('');
	L.push(`*导出于 ${formatTimestamp(now)} · 原理图连接信息导出（lceda-sch-conn-export）· 模块视图*`);

	return { markdown: `${L.join('\n')}\n`, stats, unmatched: idx.unmatched };
}

/** 网络成员 -> 连接点标签 + 是否属于选中器件（模块视图用） */
function memberTagLabels(
	net: { members: Array<{ designator: string; pinNumber: string }> },
	idx: NetIndex,
	cfg: ExportConfig,
	selKeys: Set<string>,
): Array<{ label: string; selected: boolean }> {
	const items = net.members.map((m) => {
		const comp = idx.memberComp.get(`${m.designator}\u0001${m.pinNumber}`);
		const pin = comp?.pins.find(p => p.pinNumber === m.pinNumber);
		return {
			designator: m.designator,
			pinNumber: m.pinNumber,
			pinName: pin?.pinName ?? '',
			pinType: pin?.pinType,
			selected: !!comp && selKeys.has(comp.designator.toUpperCase()),
		};
	});
	items.sort((a, b) => naturalCompare(a.designator, b.designator) || naturalCompare(a.pinNumber, b.pinNumber));
	return items.map((it) => {
		const dir = cfg.showPinType ? pinTypeShort(it.pinType) : '';
		return { label: dir ? `${pinRefLabel(it)}[${dir}]` : pinRefLabel(it), selected: it.selected };
	});
}

/** 选中器件引脚的连接点标签（模块视图对外引脚行用） */
function coreRefLabel(core: CoreComponent, row: CorePinRow, cfg: ExportConfig): string {
	const base = pinRefLabel({ designator: core.designator, pinNumber: row.pinNumber, pinName: row.pinName });
	const dir = cfg.showPinType ? pinTypeShort(row.pinType) : '';
	return dir ? `${base}[${dir}]` : base;
}
