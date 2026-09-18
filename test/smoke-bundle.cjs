const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');

/**
 * 构建产物冒烟测试 / Bundle smoke test
 *
 * 用 mock 的全局 eda 驱动 dist/index.js 的 runExport / openSettingsPanel /
 * about，验证扩展真实入口的完整导出流程（生成 Markdown -> 缓存 -> 打开
 * 预览/复制/下载窗口），全程不调用文件系统/联网接口。
 * 用法：npm run build 后 node test/smoke-bundle.cjs
 */

function primMock(getters) {
	return new Proxy({}, {
		get(_t, prop) {
			if (typeof prop === 'string' && prop.startsWith('getState_')) {
				const key = prop.replace('getState_', '');
				return () => getters[key];
			}
			return undefined;
		},
	});
}

const storage = new Map();
const dialogs = [];

const COMPS = [
	{ id: 'u1', designator: 'U1', model: 'STM32F103C8T6', footprint: 'LQFP48', pins: [
		{ number: '2', name: 'PC13' },
		{ number: '3', name: 'PC14', noConnect: true },
		{ number: '24', name: 'VDD' },
		{ number: '42', name: 'PB8' },
		{ number: '43', name: 'PB9' },
	] },
	{ id: 'u5', designator: 'U5', model: 'AT24C02', pins: [
		{ number: '5', name: 'SDA' },
		{ number: '6', name: 'SCL' },
		{ number: '8', name: 'VCC' },
	] },
	{ id: 'r4', designator: 'R4', model: '4.7k', pins: [
		{ number: '1', name: '1' },
		{ number: '2', name: '2' },
	] },
];

const NETLIST = [
	'[',
	'U1',
	']',
	'(',
	'KEY1',
	'2',
	'U1-2',
	'R4-1',
	')',
	'(',
	'I2C1_SCL',
	'3',
	'U1-42',
	'U5-6',
	'R4-1',
	')',
	'(',
	'+3V3',
	'3',
	'U1-24',
	'U5-8',
	'R4-2',
	')',
	'(',
	'I2C1_SDA',
	'2',
	'U1-43',
	'U5-5',
	')',
].join('\n');

globalThis.eda = {
	sys_Dialog: {
		showConfirmationMessage(_content, _title, _ok, _cancel, cb) { cb(true); },
		showInformationMessage(content, title) { dialogs.push(`${title}: ${content.split('\n')[0]}`); },
	},
	sys_ToastMessage: { showMessage(msg) { dialogs.push(`toast: ${msg}`); } },
	sys_LoadingAndProgressBar: {
		showProgressBar() {},
		destroyProgressBar() {},
	},
	sys_IFrame: { async openIFrame(url) { dialogs.push(`iframe: ${url}`); } },
	sys_Storage: {
		getExtensionUserConfig: k => storage.get(k),
		setExtensionUserConfig: async (k, v) => { storage.set(k, v); },
	},
	sch_SelectControl: {
		async getAllSelectedPrimitives() {
			return [primMock({ PrimitiveType: 'Component', ComponentType: 'part', Designator: 'U1', PrimitiveId: 'u1' })];
		},
	},
	sch_PrimitiveComponent: {
		async getAll() { return COMPS.map(c => primMock({ PrimitiveType: 'Component', ComponentType: 'part', PrimitiveId: c.id, Designator: c.designator, ManufacturerId: c.model, Footprint: c.footprint ? { name: c.footprint } : undefined })); },
		async getAllPinsByPrimitiveId(id) {
			const c = COMPS.find(x => x.id === id);
			return (c?.pins ?? []).map(p => primMock({ PrimitiveId: `pin-${id}-${p.number}`, PinNumber: p.number, PinName: p.name, NoConnected: p.noConnect === true }));
		},
	},
	sch_Netlist: { async getNetlist() { return NETLIST; } },
	dmt_Project: { async getCurrentProjectInfo() { return { friendlyName: 'SmokeBoard' }; } },
};

// bundle 以 `var edaEsbuildExportName = (()=>{...})()` 暴露（EDA 运行时求值读取），
// CommonJS require 拿不到模块作用域变量，这里显式求值捕获
const bundleSrc = fs.readFileSync(path.join(__dirname, '../dist/index.js'), 'utf8');
// 求值捕获是唯一手段（EDA 运行时同样以求值方式读取该变量），故豁免 no-new-func
// eslint-disable-next-line no-new-func
const api = new Function(`${bundleSrc}; return edaEsbuildExportName;`)();
if (!api) {
	throw new Error('bundle 未导出 edaEsbuildExportName');
}
for (const fn of ['runExport', 'runSelectionExport', 'openSettingsPanel', 'about']) {
	if (typeof api[fn] !== 'function')
		throw new Error(`缺少导出函数 ${fn}`);
}

let failures = 0;
const checks = [];
function ok(cond, label) {
	checks.push(`${cond ? '✓' : '✗'} ${label}`);
	if (!cond)
		failures++;
}

(async () => {
	await api.runExport();
	const cached = JSON.parse(storage.get('schConnExportLast') ?? '{}');
	const md = typeof cached.markdown === 'string' ? cached.markdown : '';
	ok(/schematic-connections-\d{8}\.md$/.test(cached.fileName ?? ''), `缓存文件名符合 前缀-日期.md（${cached.fileName}）`);
	ok(cached.truncated === false, '未截断标记');
	ok(dialogs.includes('iframe: /iframe/preview.html'), '打开了预览/复制/下载窗口');
	ok(dialogs.some(d => d.startsWith('toast: 已生成')), '完成 toast');
	ok(md.includes('# 电路连接导出：SmokeBoard'), '标题含工程名');
	ok(md.includes('### U1 — STM32F103C8T6（LQFP48）'), '核心器件章节');
	ok(md.includes('2 PC13 KEY1 = R4.1'), '信号引脚行（对端 R4.1）');
	ok(md.includes('42 PB8 I2C1_SCL = R4.1, U5.SCL(6)'), 'I2C 引脚行（对端带引脚号）');
	ok(md.includes('未连接（1）：3 PC14(NoERC)'), '未连接行（No ERC）');
	ok(md.includes('电源（已忽略，1）：24 VDD'), '电源脚行');
	ok(md.includes('I2C1_SCL: R4.1, U1.PB8(42), U5.SCL(6)') === false, '核心相关网络不重复罗列');
	ok(md.includes('```text'), '紧凑风格代码块');
	ok(md.includes('U5 AT24C02: SDA(5)=I2C1_SDA SCL(6)=I2C1_SCL'), '器件一览行');
	ok(md.includes('+3V3(3): R4.2, U1.VDD(24), U5.VCC(8)'), '电源汇总行（含计数）');
	ok(!md.includes('24 VDD +3V3'), '电源脚不进引脚清单（电源脚不会作为信号行出现）');

	await api.openSettingsPanel();
	ok(dialogs.includes('iframe: /iframe/settings.html'), '设置面板可打开');
	api.about();
	ok(dialogs.some(d => d.includes('原理图连接信息导出')), '关于对话框');

	// 网表两路皆空时的醒目告警（弹窗 + 文档头）
	globalThis.eda.sch_Netlist.getNetlist = async () => '';
	await api.runExport();
	ok(dialogs.some(d => d.includes('网表为空')), '空网表弹窗告警');
	const cachedEmpty = JSON.parse(storage.get('schConnExportLast') ?? '{}');
	ok((cachedEmpty.markdown ?? '').includes('网表读取为空'), '空网表文档头告警');

	// 核心器件为空时的错误路径（无选中 + 未配置 + 未开自动识别）
	globalThis.eda.sch_SelectControl.getAllSelectedPrimitives = async () => [];
	await api.runExport();
	ok(dialogs.some(d => d.includes('没有可用的核心器件')), '空核心器件报错提示');

	// 模块视图：选中 ≥2 器件 -> 只导出互联与对外边界
	globalThis.eda.sch_Netlist.getNetlist = async () => NETLIST;
	globalThis.eda.sch_SelectControl.getAllSelectedPrimitives = async () => [
		primMock({ PrimitiveType: 'Component', ComponentType: 'part', Designator: 'U1', PrimitiveId: 'u1' }),
		primMock({ PrimitiveType: 'Component', ComponentType: 'part', Designator: 'U5', PrimitiveId: 'u5' }),
	];
	await api.runSelectionExport();
	const cachedSel = JSON.parse(storage.get('schConnExportLast') ?? '{}');
	const mdSel = typeof cachedSel.markdown === 'string' ? cachedSel.markdown : '';
	ok(/schematic-connections-module-\d{8}\.md$/.test(cachedSel.fileName ?? ''), `模块导出文件名带 -module-（${cachedSel.fileName}）`);
	ok(mdSel.includes('# 模块连接导出：SmokeBoard（选中 2 个器件）'), '模块视图标题');
	ok(mdSel.includes('I2C1_SCL: U1.PB8(42) = U5.SCL(6)，外部：R4.1'), '互联行（未选中成员标"外部"）');
	ok(mdSel.includes('I2C1_SDA: U1.PB9(43) = U5.SDA(5)'), '纯选中互联行');
	ok(mdSel.includes('U1.PC13(2) KEY1 = R4.1'), '对外引脚行');
	ok(mdSel.includes('## 4. 电源与未连接（汇总）'), '电源/未连接汇总章节');
	ok(dialogs.some(d => d.includes('iframe: /iframe/preview.html')), '模块视图同样打开预览窗口');
	ok(!dialogs.some(d => d.startsWith('选中器件互联: 导出失败')), '选中 2 器件无报错弹窗');

	// 多器件选中时跑全图导出 -> toast 提示模块视图命令
	await api.runExport();
	ok(dialogs.some(d => d.includes('用菜单「连接信息导出 → 导出选中器件互联（模块视图）」')), '全图导出时提示模块视图命令');

	// 选中不足 2 个器件时的引导提示
	globalThis.eda.sch_SelectControl.getAllSelectedPrimitives = async () => [
		primMock({ PrimitiveType: 'Component', ComponentType: 'part', Designator: 'U1', PrimitiveId: 'u1' }),
	];
	await api.runSelectionExport();
	ok(dialogs.some(d => d.includes('需要选中至少 2 个器件')), '仅 1 个选中时引导提示');

	console.log(checks.join('\n'));
	if (failures) {
		console.error(`✗ 冒烟测试 ${failures} 项失败`);
		process.exit(1);
	}
	console.log('✓ bundle 冒烟测试全部通过');
})().catch((e) => {
	console.error('冒烟测试异常:', e);
	process.exit(1);
});
