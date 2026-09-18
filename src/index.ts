/**
 * 原理图连接信息导出 扩展入口 / Entry
 *
 * 用法（两条导出命令，均在原理图编辑器菜单「连接信息导出」下）：
 * - 「导出连接信息」：整图收集器件与网表，生成以核心器件为中心的 Markdown
 *   连接文档。核心器件 = 选中位号 ∪ 设置里配置的位号（也可开自动识别）。
 * - 「导出选中器件互联」：模块视图——框选本功能模块的器件（≥2 个，如
 *   MCU + 485 收发器 + 接口座）后运行，只输出选中器件之间的互联网络、
 *   对外信号引脚（模块边界）与电源/未连接汇总，逐模块开发/审阅更省事。
 *
 * 两条命令都在预览窗口中一键复制全文给大模型，或用窗口内下载按钮存 .md。
 * 全程不调用联网/本地文件系统接口（不触发"外部交互权限"安装提示）：
 * 内容经 sys_Storage 传给 iframe 窗口，落盘走窗口内的浏览器下载。
 */
import {
	collectSnapshot,
	getSelectedDesignators,
	loadConfig,
	storeLastExport,
} from './eda-adapter.ts';
import { defaultFileName, renderMarkdown, renderSelectionMarkdown, summaryText } from './markdown.ts';
import {
	buildCoreComponents,
	buildNetIndex,
	resolveCores,
} from './model.ts';

declare const eda: any;

/* ---------------- 对话框封装 ---------------- */

function info(content: string, title: string): void {
	eda.sys_Dialog.showInformationMessage(content, title);
}

function toast(msg: string): void {
	eda.sys_ToastMessage.showMessage(msg, 0 /* INFO */);
}

/* ---------------- 构建文档 ---------------- */

interface BuildResult {
	markdown: string;
	coreNames: string[];
	missing: string[];
	stats: ReturnType<typeof renderMarkdown>['stats'];
	unmatched: string[];
	fileName: string;
	/** 网表两个来源都为空（结果不可信，需醒目提示） */
	netlistEmpty: boolean;
	/** 画布选中的器件数（≥2 时提示模块视图命令，避免误把整板导出当模块互联用） */
	selectedCount: number;
}

async function buildDocument(onProgress?: (pct: number, msg: string) => void): Promise<BuildResult> {
	const cfg = loadConfig();

	onProgress?.(10, '收集全部图页器件与网表…');
	const snapshot = await collectSnapshot();
	if (!snapshot.components.length)
		throw new Error('没有读到任何器件——请确认已在原理图编辑器中打开工程');

	onProgress?.(45, '读取选中器件…');
	const selected = await getSelectedDesignators();

	const { cores, missing, autoUsed } = resolveCores(snapshot, cfg, selected);
	if (!cores.length)
		throw new Error('没有可用的核心器件：请在原理图中选中 MCU/FPGA 等器件（或在「设置面板 → 核心器件位号」填写位号；也可开启自动识别）');

	onProgress?.(70, `整理 ${cores.length} 个核心器件的连接…`);
	const idx = buildNetIndex(snapshot, cfg);
	const coreComps = buildCoreComponents(cores, idx, cfg);
	const rendered = renderMarkdown(snapshot, cfg, coreComps, idx);
	if (rendered.unmatched.length)
		console.warn(`[sch-connexport] 未匹配到画布器件的网表连接点（${rendered.unmatched.length} 个）：\n${rendered.unmatched.slice(0, 80).join('\n')}${rendered.unmatched.length > 80 ? '\n…' : ''}`);

	const coreNames = cores.map(c => `${c.designator}（${c.model || '型号未知'}，${c.pins.length} 脚）`);
	console.log(`[sch-connexport] 导出汇总：核心器件 ${coreNames.join('、')}${autoUsed ? '（自动识别）' : ''}${missing.length ? `；未找到位号 ${missing.join('、')}` : ''}\n${summaryText(rendered.stats)}`);

	return {
		markdown: rendered.markdown,
		coreNames,
		missing,
		stats: rendered.stats,
		unmatched: rendered.unmatched,
		fileName: defaultFileName(cfg, new Date()),
		netlistEmpty: snapshot.netlistEmpty,
		selectedCount: selected.length,
	};
}

/* ---------------- 结果展示（两条导出命令共用） ---------------- */

/** 缓存导出内容 -> 控制台留全文 -> 打开预览/复制/下载窗口（不可用时引导控制台复制） */
async function presentExport(
	markdown: string,
	fileName: string,
	toastMsg: string,
	netlistEmpty: boolean,
	fallbackSummary: string,
): Promise<void> {
	const stored = await storeLastExport(markdown, fileName);
	// 控制台同时留一份全文：预览窗口不可用时的兜底复制来源
	console.log(`[sch-connexport] Markdown 全文（${markdown.length} 字符，${fileName}）：\n${markdown}`);

	if (stored) {
		await eda.sys_IFrame.openIFrame('/iframe/preview.html', 760, 660, 'sch-connexport-preview', {
			maximizeButton: false,
			minimizeButton: true,
			title: `连接信息导出 · ${fileName}`,
		});
		toast(toastMsg);
		if (netlistEmpty) {
			info(
				'⚠ 网表读取为空：所有引脚都显示为"未连接"，这不代表真实电路！\n\n'
				+ '网表接口（sch_Netlist / sch_ManufactureData）与几何法重建（导线+引脚坐标）都未能获得网络连接。\n'
				+ '请：1) 确认工程已保存；2) 重试一次；3) 仍为空时打开开发者工具控制台（过滤 sch-connexport），把诊断信息反馈给开发者。',
				'网表为空',
			);
		}
	}
	else {
		info(
			`预览窗口不可用，全文已输出到控制台（EDA 菜单「设置 - 扩展 - 开发者工具」，Console 过滤 sch-connexport，可直接复制）。\n\n${fallbackSummary}`,
			'连接信息导出',
		);
	}
}

/* ---------------- 命令 ---------------- */

/** 导出连接信息（主命令）：生成 Markdown 并打开预览/复制/下载窗口 */
export async function runExport(): Promise<void> {
	try {
		eda.sys_LoadingAndProgressBar.showProgressBar(Number.NaN, '分析原理图连接…');
		const built = await buildDocument((pct, msg) => eda.sys_LoadingAndProgressBar.showProgressBar(pct, msg));
		eda.sys_LoadingAndProgressBar.destroyProgressBar();

		await presentExport(
			built.markdown,
			built.fileName,
			`已生成 ${built.fileName}（${built.stats.signalNetCount} 个信号网络），在窗口中复制或下载`,
			built.netlistEmpty,
			summaryText(built.stats),
		);
		// 联动提示：多器件选中时，想看的往往是"它们之间怎么连"——指向模块视图命令
		if (built.selectedCount >= 2)
			toast(`选中了 ${built.selectedCount} 个器件：只需看它们之间的互联时，用菜单「连接信息导出 → 导出选中器件互联（模块视图）」`);
	}
	catch (e) {
		eda.sys_LoadingAndProgressBar.destroyProgressBar();
		info(`导出失败：${e instanceof Error ? e.message : String(e)}\n\n提示：请确认已打开原理图编辑器；核心器件可先在图中选中，或在设置面板配置位号。`, '原理图连接信息导出');
	}
}

/** 导出选中器件互联（模块视图）：只围绕画布选中的器件（≥2 个）输出互联与对外边界 */
export async function runSelectionExport(): Promise<void> {
	try {
		eda.sys_LoadingAndProgressBar.showProgressBar(Number.NaN, '分析选中器件互联…');
		const cfg = loadConfig();

		eda.sys_LoadingAndProgressBar.showProgressBar(15, '收集全部图页器件与网表…');
		const snapshot = await collectSnapshot();
		if (!snapshot.components.length)
			throw new Error('没有读到任何器件——请确认已在原理图编辑器中打开工程');

		eda.sys_LoadingAndProgressBar.showProgressBar(45, '读取选中器件…');
		const selected = await getSelectedDesignators();
		// 只认画布选中：不并入设置位号、不自动识别，保证"只导出这一部分"的语义
		const { cores, missing } = resolveCores(snapshot, { ...cfg, coreDesignators: '', autoDetectCore: false }, selected);
		if (cores.length < 2) {
			throw new Error(
				`需要选中至少 2 个器件（当前 ${cores.length} 个${missing.length ? `，未找到位号：${missing.join('、')}` : ''}）。\n`
				+ '用法：在原理图中框选本功能模块的全部器件（如 MCU + 485 收发器 + 接口座）后再运行本命令；全图导出请用「导出连接信息」。',
			);
		}

		eda.sys_LoadingAndProgressBar.showProgressBar(70, `整理 ${cores.length} 个选中器件的互联…`);
		const idx = buildNetIndex(snapshot, cfg);
		const coreComps = buildCoreComponents(cores, idx, cfg);
		const rendered = renderSelectionMarkdown(snapshot, cfg, coreComps, idx);
		if (rendered.unmatched.length)
			console.warn(`[sch-connexport] 未匹配到画布器件的网表连接点（${rendered.unmatched.length} 个）：\n${rendered.unmatched.slice(0, 80).join('\n')}${rendered.unmatched.length > 80 ? '\n…' : ''}`);

		const fileName = defaultFileName(cfg, new Date(), 'module');
		console.log(`[sch-connexport] 模块导出汇总：选中 ${cores.map(c => c.designator).join('、')}；互联 ${rendered.stats.interconnectCount} 网络，对外 ${rendered.stats.boundaryCount} 引脚，电源 ${rendered.stats.powerPinCount}，未连接 ${rendered.stats.unconnectedPinCount}`);
		eda.sys_LoadingAndProgressBar.destroyProgressBar();

		await presentExport(
			rendered.markdown,
			fileName,
			`已生成 ${fileName}（互联 ${rendered.stats.interconnectCount} 网络 · 对外 ${rendered.stats.boundaryCount} 引脚），在窗口中复制或下载`,
			snapshot.netlistEmpty,
			`选中 ${rendered.stats.selectedCount} 个器件：互联 ${rendered.stats.interconnectCount} 网络，对外 ${rendered.stats.boundaryCount} 引脚。`,
		);
	}
	catch (e) {
		eda.sys_LoadingAndProgressBar.destroyProgressBar();
		info(`导出失败：${e instanceof Error ? e.message : String(e)}\n\n提示：本命令只看画布选中——先框选模块的全部器件再运行。`, '选中器件互联');
	}
}

/** 设置面板（iframe 图形界面，经 eda.sys_Storage 共享存储直接读写配置） */
export async function openSettingsPanel(): Promise<void> {
	await eda.sys_IFrame.openIFrame('/iframe/settings.html', 560, 640, 'sch-connexport-settings', {
		maximizeButton: false,
		minimizeButton: true,
		title: '连接信息导出设置',
	});
}

export function about(): void {
	const cfg = loadConfig();
	const autoText = cfg.autoDetectCore ? `开（≥${cfg.autoDetectMinPins} 脚）` : '关';
	info(
		'原理图连接信息导出（lceda-sch-conn-export）\n\n'
		+ '把整份原理图的网络连接导出为 Markdown，供大模型/开发者查阅：以选中的 MCU/FPGA/DSP 等核心器件为中心输出引脚号、引脚名与互联关系，电源地等网络可配置忽略，另附信号网络清单、其它器件型号一览与被忽略电源网络汇总。\n\n'
		+ `当前配置：核心器件位号 ${cfg.coreDesignators || '（未配置，以画布选中为准）'}，自动识别 ${autoText}，忽略电源/地 ${cfg.ignorePower ? '开' : '关'}，忽略名单 ${cfg.ignoreNets.split(',').length} 项。\n\n`
		+ '导出结果在预览窗口中一键复制给大模型，或用下载按钮存 .md（默认名 schematic-connections-日期.md，前缀可在设置中改）。全程不联网、不直接读写本地文件，无需开启扩展"外部交互"权限。',
		'关于',
	);
}
