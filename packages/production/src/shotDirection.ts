export const cameraMoves = ["固定", "缓慢推进", "缓慢拉远", "横向跟拍", "缓慢摇镜"] as const;
export type ShotDirection = {
  summary: string; action: string; camera: typeof cameraMoves[number];
  positions: Array<{ name: string; start: string; end: string }>;
  environment: string; style: string; sound: string;
};

/** Creative fields only. Reference numbers, dialogue and timing belong to the compiler. */
export function validateShotDirection(value: unknown, names: string[]): asserts value is ShotDirection {
  const d = value as ShotDirection | null;
  if (!d || typeof d !== "object" || Array.isArray(d)
    || Object.keys(d).some(key => !["summary", "action", "camera", "positions", "environment", "style", "sound"].includes(key))
    || !cameraMoves.includes(d.camera)) throw new Error("镜头导演资料缺失或主运镜无效");
  for (const key of ["summary", "action", "environment", "style", "sound"] as const) {
    if (typeof d[key] !== "string" || d[key].length > 1200 || key !== "sound" && !d[key].trim()) throw new Error(`镜头导演资料 ${key} 无效`);
  }
  if (!Array.isArray(d.positions) || d.positions.length !== names.length
    || new Set(d.positions.map(item => item?.name)).size !== names.length
    || d.positions.some(item => !item || !names.includes(item.name)
      || Object.keys(item).some(key => !["name", "start", "end"].includes(key))
      || [item.start, item.end].some(text => typeof text !== "string" || !text.trim() || text.length > 400))) {
    throw new Error("每个出场人物必须有唯一的起止站位、朝向与视线描述");
  }
}
