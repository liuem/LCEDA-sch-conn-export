/**
 * 几何工具 / Geometry helpers
 *
 * 供"几何法网络重建"使用：导线顶点解析与"点是否落在导线段上"判定。
 * 坐标单位：原理图画布（整数网格），容差 eps=1（与 net-fanout 实测一致）。
 */

/** 多段线坐标组 -> 顶点列表（兼容 [x1,y1,...] 与 [[x,y],...] 两种形态） */
export function wireVertices(line: number[] | Array<Array<number>> | undefined): Array<{ x: number; y: number }> {
	const pts: Array<{ x: number; y: number }> = [];
	if (!Array.isArray(line))
		return pts;
	if (typeof line[0] === 'number') {
		for (let i = 0; i + 1 < (line as number[]).length; i += 2)
			pts.push({ x: Number(line[i]), y: Number(line[i + 1]) });
	}
	else {
		for (const p of line as Array<Array<number>>)
			pts.push({ x: Number(p?.[0]), y: Number(p?.[1]) });
	}
	return pts.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
}

/** 点到线段距离的平方 */
export function distPointToSegSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax;
	const dy = by - ay;
	const lenSq = dx * dx + dy * dy;
	let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
	t = Math.max(0, Math.min(1, t));
	const ex = ax + t * dx - px;
	const ey = ay + t * dy - py;
	return ex * ex + ey * ey;
}

/** 点是否落在导线段上（eps 容差，画布整数坐标默认 1） */
export function pointOnSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number, eps = 1): boolean {
	return distPointToSegSq(px, py, ax, ay, bx, by) <= eps * eps;
}

/** 坐标量化键（并查集节点） */
export function coordKey(x: number, y: number): string {
	return `${Math.round(x)}\u0001${Math.round(y)}`;
}

/** 简单并查集 / Union-Find */
export class DisjointSet {
	private parent = new Map<string, string>();

	find(k: string): string {
		let root = k;
		while (this.parent.get(root) !== root)
			root = this.parent.get(root) ?? root;
		// 路径压缩
		let cur = k;
		while (this.parent.get(cur) !== cur) {
			const next = this.parent.get(cur)!;
			this.parent.set(cur, root);
			cur = next;
		}
		this.parent.set(k, root);
		return root;
	}

	union(a: string, b: string): void {
		const ra = this.find(a);
		const rb = this.find(b);
		if (ra !== rb)
			this.parent.set(ra, rb);
	}

	ensure(k: string): void {
		if (!this.parent.has(k))
			this.parent.set(k, k);
	}
}
