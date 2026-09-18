/**
 * 公共类型与默认配置 / Types & default config
 *
 * 目标：把原理图网络连接整理成"非多模态大模型也能读懂"的 Markdown——
 * 以 MCU/FPGA/DSP 等需写程序的核心器件为中心，给出引脚号/引脚名/互联，
 * 电源地可忽略（可配），并附信号网络总表与器件型号一览。
 */

export interface ExportConfig {
	/** 核心器件位号（逗号/分号/空白/换行分隔，忽略大小写），与画布选中共用：并集 */
	coreDesignators: string;
	/** 无选中且未配置位号时，自动把引脚数 ≥ autoDetectMinPins 的器件当核心，默认关 */
	autoDetectCore: boolean;
	/** 自动识别核心器件的最小引脚数，默认 24 */
	autoDetectMinPins: number;
	/** 忽略电源/地网络（总开关，默认开） */
	ignorePower: boolean;
	/** 忽略网络名单（逗号/分号/换行分隔，忽略大小写整词匹配，支持 * 通配） */
	ignoreNets: string;
	/** 按引脚名判定电源脚（VDD、VSS、VCC、GND 等前缀，网络名没命中名单时的兜底），默认开 */
	powerByPinName: boolean;
	/** 核心器件表后列出未连接引脚（含 No ERC），默认开 */
	showUnconnected: boolean;
	/** 附「信号网络总表」（按网络看全部连接点），默认开 */
	includeNetSection: boolean;
	/** 附「其它器件一览」（位号/型号/信号连接），默认开 */
	includeComponentsSection: boolean;
	/** 文末附被忽略的电源网络汇总，默认开 */
	includePowerSummary: boolean;
	/** 导出文件名前缀（默认 schematic-connections，文件名=前缀-日期.md） */
	filePrefix: string;
	/** 输出风格：compact=紧凑文本行（代码块，省 token，默认）；table=Markdown 表格 */
	outputStyle: 'compact' | 'table';
	/** 网络总表范围：auto=只列不经过核心器件的网络（核心相关已在核心表完整展开，默认）；all=全部 */
	netSectionScope: 'auto' | 'all';
	/** 核心器件表中标注引脚电气方向（[I]/[O]/[IO]，符号未定义方向的不标），默认关 */
	showPinType: boolean;
}

/** 常见电源/地网络默认忽略名单（用户可在设置页增删，支持 * 通配） */
export const DEFAULT_IGNORE_NETS = [
	'GND',
	'AGND',
	'DGND',
	'PGND',
	'EGND',
	'SGND',
	'GNDA',
	'GND*',
	'*GND',
	'VSS',
	'VSSA',
	'VSS*',
	'VDD',
	'VDDA',
	'VDDIO',
	'VDD*',
	'VREF*',
	'VCCA',
	'VCC',
	'VCC*',
	'AVCC',
	'AVDD',
	'AVSS',
	'DVCC',
	'DVDD',
	'DVSS',
	'VEE',
	'VEE*',
	'VBAT',
	'VBAT*',
	'VBUS',
	'VIN',
	'VSYS',
	'VPHY',
	'+3V3',
	'+5V',
	'+1V8',
	'+2V5',
	'+1V2',
	'+*',
	'-*',
	'3V3',
	'5V',
	'1V8',
	'1V2',
	'2V5',
	'3V0',
	'2V8',
	'1V1',
	'NC',
].join(',');

/** 引脚名层面的电源/地/不连接判定（内置，网络名名单之外的第二道兜底） */
export const POWER_PIN_NAME_PATTERNS = [
	'VDD*',
	'VSS*',
	'VCC*',
	'VEE*',
	'VDDA*',
	'VSSA*',
	'VCCA*',
	'VBAT*',
	'VREF*',
	'VBR?',
	'VDDIO*',
	'VPLL*',
	'VPHY*',
	'VCAP*',
	'VLCD*',
	'VUSB*',
	'GND',
	'GND*',
	'*GND',
	'AGND*',
	'DGND*',
	'PGND*',
	'EP',
	'PAD',
	'PAD*',
	'NC',
	'N.C.',
];

export const DEFAULT_CONFIG: ExportConfig = {
	coreDesignators: '',
	autoDetectCore: false,
	autoDetectMinPins: 24,
	ignorePower: true,
	ignoreNets: DEFAULT_IGNORE_NETS,
	powerByPinName: true,
	showUnconnected: true,
	includeNetSection: true,
	includeComponentsSection: true,
	includePowerSummary: true,
	filePrefix: 'schematic-connections',
	outputStyle: 'compact',
	netSectionScope: 'auto',
	showPinType: false,
};

/* ------------------------- 数据模型（纯数据，供渲染与测试） ------------------------- */

/** 器件引脚（来自画布符号，含引脚名） */
export interface RawPin {
	pinNumber: string;
	pinName: string;
	/** 带"不连接(No ERC)"标记 */
	noConnect: boolean;
	/** 引脚电气类型（IN/OUT/BI/Passive/Power...，符号未设置为空） */
	pinType?: string;
	/** 引脚连接点画布坐标（几何法网络重建用；读不到为 undefined） */
	x?: number;
	y?: number;
}

/** 器件（画布上的普通器件；多子部件会聚合为同一 designator） */
export interface RawComponent {
	/** 聚合后的位号（基准位号，如 U1；不含子部件后缀） */
	designator: string;
	/** 型号/值：制造商编号 > 名称 > 库器件名 > 符号名 */
	model: string;
	manufacturer?: string;
	footprint?: string;
	/** 子部件列表（多子部件器件如 U1A/U1B，通常为空） */
	subParts: string[];
	pins: RawPin[];
}

/** 网表网络：网络名 + 成员（位号-引脚号，位号保留 netlist 原样形态） */
export interface RawNet {
	name: string;
	members: Array<{ designator: string; pinNumber: string }>;
}

/** 整图电气快照 */
export interface SchSnapshot {
	projectName: string;
	components: RawComponent[];
	nets: RawNet[];
}

/** 引脚在导出中的分类 */
export type PinClass = 'signal' | 'power' | 'unconnected';

/** 归一后的连接点引用（位号.引脚名，引脚名缺省用引脚号） */
export interface PinRef {
	designator: string;
	pinNumber: string;
	pinName: string;
}

/** 核心器件引脚行（渲染用） */
export interface CorePinRow {
	pinNumber: string;
	pinName: string;
	net?: string;
	cls: PinClass;
	noConnect: boolean;
	/** 引脚电气类型原始值（IN/OUT/BI...，可缺省） */
	pinType?: string;
	/** 网络上的其它连接点（不含本引脚） */
	peers: PinRef[];
}

/** 核心器件渲染单元 */
export interface CoreComponent {
	designator: string;
	model: string;
	manufacturer?: string;
	footprint?: string;
	pins: CorePinRow[];
}

/** 导出统计（对话框/文档头展示） */
export interface ExportStats {
	componentCount: number;
	coreCount: number;
	netCount: number;
	signalNetCount: number;
	powerNetCount: number;
	coreSignalPins: number;
	corePowerPins: number;
	coreUnconnectedPins: number;
	/** 网表成员在画布上找不到对应器件的次数（多子部件/特殊位号会造成少量） */
	unmatchedMembers: number;
}

/** 渲染结果 */
export interface RenderedDoc {
	markdown: string;
	stats: ExportStats;
	/** 未能匹配到画布器件的网络成员明细（诊断用，`位号-引脚号@网络`） */
	unmatched: string[];
}

/** 模块视图（选中器件互联）统计 */
export interface SelectionStats {
	/** 选中的器件数 */
	selectedCount: number;
	/** 连接 ≥2 个选中器件的信号网络数（模块内部互联） */
	interconnectCount: number;
	/** 只连到单一选中器件、对外延伸的信号引脚数（模块边界） */
	boundaryCount: number;
	powerPinCount: number;
	unconnectedPinCount: number;
	unmatchedMembers: number;
}

/** 模块视图渲染结果 */
export interface RenderedSelectionDoc {
	markdown: string;
	stats: SelectionStats;
	unmatched: string[];
}
