"""Compile a validated, millimetre-based shape description with build123d."""

from collections import deque
from math import hypot, inf
from typing import NamedTuple

from build123d import Color, Compound, Face, Plane, Pos, Solid, Vector, Wire, export_step


PLANES = {
    "XY": ((1, 0, 0), (0, 0, 1)),
    "XZ": ((1, 0, 0), (0, -1, 0)),
    "YZ": ((0, 1, 0), (1, 0, 0)),
}
COLORS = {
    "body": "#303540",
    "metal": "#BCC3CE",
    "mark": "#D9DFE8",
    "plastic": "#4E6783",
    "ceramic": "#D7C098",
    "terminal": "#C8A663",
    "enclosure": "#BCC3CE",
    "contact": "#D6B268",
}

SHAPE_NAMES = {"box": "盒体", "cylinder": "圆柱", "sphere": "球体", "prism": "轮廓拉伸", "loft": "截面放样"}
BODY_ROLES = {"body", "plastic", "ceramic", "enclosure"}
NON_SUPPORT_ROLES = {"terminal", "contact", "mark"}
FIT_CLEARANCE_MM = 0.08


class PartInstance(NamedTuple):
    name: str
    prototype: str
    role: str
    lower: list
    upper: list
    shape: object


def is_valid(shape):
    return shape.is_valid() if callable(shape.is_valid) else shape.is_valid


def profile_wire(outline, origin, horizontal, vertical):
    area = sum(x * v - y * u for (x, y), (u, v) in zip(outline, outline[1:] + outline[:1]))
    if area < 0:
        # Reverse winding without changing the first corresponding vertex.
        outline = outline[:1] + outline[:0:-1]
    points = [origin + horizontal * x + vertical * y for x, y in outline]
    return Wire.make_polygon(points, close=True)


def shape_from(spec):
    kind, at, size = spec["kind"], spec["at"], spec["size"]
    if kind == "box":
        return Solid.make_box(*size, plane=Plane(origin=at))
    if kind == "sphere":
        return Solid.make_sphere(size[0], plane=Plane(origin=at))
    x_dir, normal = PLANES[spec["plane"]]
    if kind == "cylinder":
        return Solid.make_cylinder(*size, plane=Plane(origin=at, x_dir=x_dir, z_dir=normal))
    origin = Vector(at)
    horizontal = Vector(x_dir)
    direction = Vector(normal)
    vertical = direction.cross(horizontal)
    if kind == "prism":
        face = Face(profile_wire(spec["profile"], origin, horizontal, vertical))
        if not is_valid(face):
            raise ValueError("截面无法围成有效平面，请检查顶点顺序和重复折返的边。")
        return Solid.extrude(face, direction * size[0])
    if kind == "loft":
        wires = [profile_wire(section["profile"], origin + direction * section["offset"], horizontal, vertical)
                 for section in spec["sections"]]
        return Solid.make_loft(wires, ruled=True)
    raise ValueError("无法识别实体类型。")


def volume(shape):
    if shape is None:
        return 0.0
    if hasattr(shape, "volume"):
        return shape.volume
    return sum(volume(item) for item in shape)


def bounds_as_text(shape):
    box = shape.bounding_box()
    return f"{[round(v, 3) for v in box.min]} 到 {[round(v, 3) for v in box.max]}"


def checked_shape(spec, label):
    kind = spec["kind"]
    try:
        shape = shape_from(spec)
    except Exception as error:
        raise ValueError(f"{label}（{SHAPE_NAMES[kind]}）生成失败：{str(error) or type(error).__name__}") from error
    if not is_valid(shape):
        hint = "请检查相邻截面同名角点的顺序和对应关系。" if kind == "loft" else "请检查轮廓和尺寸。"
        raise ValueError(f"{label}（{SHAPE_NAMES[kind]}）的拓扑无效。{hint}")
    return shape


def part_geometry(part):
    name = part["id"]
    original = checked_shape(part["shape"], name + " 原型")
    solid = original
    remaining = volume(solid)
    warnings = []
    if remaining <= 0:
        raise ValueError(f"实体没有可导出的体积：{name}")
    for index, cut in enumerate(part["cuts"], 1):
        tool = checked_shape(cut, f"{name} 第 {index} 个切削体")
        try:
            result = solid.cut(tool)
        except Exception as error:
            raise ValueError(f"{name} 第 {index} 次切削失败：{str(error) or type(error).__name__}") from error
        new_volume = volume(result)
        if new_volume <= 0:
            raise ValueError(f"{name} 的第 {index} 个切削移除了整个实体。")
        if not is_valid(result):
            raise ValueError(f"{name} 第 {index} 次切削后的拓扑无效。请检查刀具是否与零件相切或重合。")
        if remaining - new_volume <= max(1e-9, remaining * 1e-10):
            if index > 1 and volume(original.intersect(tool)) > 1e-9:
                warnings.append(f"{name} 的第 {index} 个切削区域已由前序切削移除，请核对开口轮廓。")
                continue
            raise ValueError(
                f"{name} 的第 {index} 个切削没有移除材料。沿 XYZ 的包围盒（mm），"
                f"实体 {bounds_as_text(solid)}，刀具 {bounds_as_text(tool)}。请检查切削起点、方向和深度。"
            )
        solid, remaining = result, new_volume
    return solid, warnings


def measure_assembly(instances):
    lower = [min(item.lower[axis] for item in instances) for axis in range(3)]
    upper = [max(item.upper[axis] for item in instances) for axis in range(3)]
    extremes = [
        {"from": min(instances, key=lambda item: item.lower[axis]).name,
         "to": max(instances, key=lambda item: item.upper[axis]).name}
        for axis in range(3)
    ]
    return {"min": lower, "max": upper, "size": [high - low for low, high in zip(lower, upper)],
            "extremes": extremes}


def enclosure_warnings(instances):
    enclosure = [item for item in instances if item.role == "enclosure"]
    contacts = [item for item in instances if item.role == "contact"]
    if not enclosure or not contacts:
        return []
    bounds = measure_assembly(enclosure)
    warnings = []
    for axis, label in enumerate("XYZ"):
        low, high = bounds["min"][axis], bounds["max"][axis]
        outside = [part.name for part in contacts if part.lower[axis] < low - 0.05 or part.upper[axis] > high + 0.05]
        if outside:
            warnings.append(f"内部配接触点 {outside[0]} 等 {len(outside)} 个沿 {label} 轴超出外壳范围 [{low:.3f}, {high:.3f}] mm。")
    return warnings


def box_gap(first, second):
    return hypot(*(max(first.lower[axis] - second.upper[axis], second.lower[axis] - first.upper[axis], 0)
                   for axis in range(3)))


def closest_connected_part(part, connected):
    nearest, distance = None, inf
    for lower_bound, reference in sorted(((box_gap(part, ref), ref) for ref in connected), key=lambda item: item[0]):
        if lower_bound >= distance:
            break
        gap = part.shape.distance_to(reference.shape)
        if gap < distance:
            nearest, distance = reference, gap
    return nearest, distance


def alignment_warnings(instances):
    anchors = [item for item in instances if item.role in BODY_ROLES]
    if not anchors or len(instances) < 2:
        return []
    anchor = max(anchors, key=lambda item: volume(item.shape))
    supports = [anchor]
    pending = deque([anchor])
    loose = [item for item in instances if item is not anchor]
    while pending and loose:
        reference = pending.popleft()
        remaining = []
        for part in loose:
            if box_gap(reference, part) <= FIT_CLEARANCE_MM and reference.shape.distance_to(part.shape) <= FIT_CLEARANCE_MM:
                # A neighboring pin or surface mark does not provide a structural joint.
                if part.role not in NON_SUPPORT_ROLES:
                    supports.append(part)
                    pending.append(part)
            else:
                remaining.append(part)
        loose = remaining

    groups = {}
    for part in loose:
        groups.setdefault(part.prototype, []).append(part)
    warnings = []
    for parts in groups.values():
        part = parts[0]
        nearest, gap = closest_connected_part(part, supports)
        if nearest is None:
            continue
        _, part_point, support_point = part.shape.distance_to_with_closest_points(nearest.shape)
        start = [round(value, 3) for value in part_point]
        end = [round(value, 3) for value in support_point]
        count = f"（共 {len(parts)} 件）" if len(parts) > 1 else ""
        warnings.append(f"{part.name}{count} 与主体装配分离，距最近的已装配零件 {nearest.name} 有 {gap:.3f} mm。"
                        f"{part.name} 的 XYZ 范围 {bounds_as_text(part.shape)}，{nearest.name} 的范围 {bounds_as_text(nearest.shape)}。"
                        f"两零件最近表面点（XYZ mm）为 {part.name} {start} 和 {nearest.name} {end}。")
    return warnings


def terminal_layout(instances):
    groups = {}
    for instance in instances:
        if instance.role == "terminal":
            groups.setdefault(instance.prototype, []).append(instance)
    layout = []
    for prototype, terminals in groups.items():
        bounds = measure_assembly(terminals)
        centers = [[round((low + high) / 2, 4) for low, high in zip(terminal.lower, terminal.upper)]
                   for terminal in (terminals[0], terminals[-1])]
        layout.append({"id": prototype, "count": len(terminals), "min": bounds["min"], "max": bounds["max"],
                       "firstBoxCenter": centers[0], "lastBoxCenter": centers[1]})
    return layout


def create_model(plan, step_path):
    solids, instances, meshes, warnings = [], [], [], []
    for part in plan["parts"]:
        solid, cut_warnings = part_geometry(part)
        warnings.extend(cut_warnings)
        bbox = solid.bounding_box()
        vertices, triangles = solid.tessellate(tolerance=0.02, angular_tolerance=0.18)
        if not triangles:
            raise ValueError(f"{part['id']} 的实体无法生成预览网格。")

        role, offsets = part["role"], part["offsets"]
        appearance = part.get("appearance", {})
        color = appearance.get("color", COLORS[role])
        meshes.append({"color": color, "material": appearance.get("material"), "offsets": offsets,
                       "vertices": [value for point in vertices for value in point],
                       "triangles": [index for triangle in triangles for index in triangle]})
        for index, offset in enumerate(offsets, 1):
            shape = Pos(*offset) * solid
            name = part["id"] if len(offsets) == 1 else f"{part['id']}-{index}"
            shape.label = name
            shape.color = Color(color)
            solids.append(shape)
            instances.append(PartInstance(name, part["id"], role,
                                          [v + delta for v, delta in zip(bbox.min, offset)],
                                          [v + delta for v, delta in zip(bbox.max, offset)], shape))

    if not export_step(Compound(label=plan["name"], children=solids), step_path):
        raise ValueError("build123d 未能导出 STEP。")
    bodies = [item for item in instances if item.role == "body"]
    if not bodies:
        bodies = [item for item in instances if item.role in BODY_ROLES]
    body_size = measure_assembly(bodies)["size"] if len(bodies) == 1 else None
    return {**measure_assembly(instances), "bodySize": body_size,
            "mechanicalWarnings": warnings + enclosure_warnings(instances),
            "alignmentWarnings": alignment_warnings(instances), "terminalLayout": terminal_layout(instances), "meshes": meshes}
