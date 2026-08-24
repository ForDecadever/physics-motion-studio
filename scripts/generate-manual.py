from __future__ import annotations

import argparse
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from PIL import Image
from pypdf import PdfReader
from reportlab.lib.colors import Color, HexColor
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
SNAPSHOTS = ROOT / "e2e" / "visual.spec.ts-snapshots"
OUTPUT_PDF = ROOT / "output" / "pdf" / "Motion-Studio-1.6.1-使用手册.pdf"
PUBLIC_PDF = ROOT / "public" / "docs" / "Motion-Studio-1.6.1-Manual-zh-CN.pdf"

PAGE_WIDTH, PAGE_HEIGHT = landscape(A4)
MARGIN = 34
HEADER_Y = PAGE_HEIGHT - 38
FOOTER_Y = 18

BG = HexColor("#111419")
PANEL = HexColor("#1b2027")
PANEL_2 = HexColor("#242b34")
TEXT = HexColor("#edf3f9")
MUTED = HexColor("#9ba8b7")
ACCENT = HexColor("#58a6ff")
ACCENT_2 = HexColor("#59d499")
WARN = HexColor("#f4b860")
RED = HexColor("#ff6b6b")
GRID = HexColor("#35404d")


@dataclass(frozen=True)
class Marker:
    number: int
    x: float
    y: float
    label: str


@dataclass(frozen=True)
class PageSpec:
    section: str
    title: str
    subtitle: str
    bullets: tuple[str, ...] = ()
    image: str | None = None
    markers: tuple[Marker, ...] = ()
    note: str | None = None
    layout: str = "standard"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="生成 Motion Studio v1.6.1 中文使用手册")
    parser.add_argument("--spring-image", type=Path)
    parser.add_argument("--magnetic-model-image", type=Path)
    parser.add_argument("--magnetic-detail-image", type=Path)
    return parser.parse_args()


def register_fonts() -> None:
    font_regular = Path(r"C:\Windows\Fonts\msyh.ttc")
    font_bold = Path(r"C:\Windows\Fonts\msyhbd.ttc")
    fallback = Path(r"C:\Windows\Fonts\simhei.ttf")
    if font_regular.exists() and font_bold.exists():
        pdfmetrics.registerFont(TTFont("ManualSans", str(font_regular), subfontIndex=0))
        pdfmetrics.registerFont(TTFont("ManualSansBold", str(font_bold), subfontIndex=0))
    elif fallback.exists():
        pdfmetrics.registerFont(TTFont("ManualSans", str(fallback)))
        pdfmetrics.registerFont(TTFont("ManualSansBold", str(fallback)))
    else:
        raise FileNotFoundError("没有找到可嵌入的中文字体。")


def tokens(text: str) -> Iterable[str]:
    current = ""
    for char in text:
        if char.isspace():
            if current:
                yield current
                current = ""
            yield char
        elif "\u4e00" <= char <= "\u9fff" or char in "，。；：！？（）【】《》、·—“”‘’":
            if current:
                yield current
                current = ""
            yield char
        else:
            current += char
    if current:
        yield current


def wrap_text(text: str, font: str, size: float, width: float) -> list[str]:
    lines: list[str] = []
    line = ""
    for token in tokens(text):
        candidate = f"{line}{token}"
        if line and pdfmetrics.stringWidth(candidate, font, size) > width:
            lines.append(line.rstrip())
            line = token.lstrip()
        else:
            line = candidate
    if line:
        lines.append(line.rstrip())
    return lines or [""]


def draw_lines(
    pdf: canvas.Canvas,
    text: str,
    x: float,
    y: float,
    width: float,
    *,
    font: str = "ManualSans",
    size: float = 10,
    leading: float = 15,
    color: Color = TEXT,
) -> float:
    pdf.setFont(font, size)
    pdf.setFillColor(color)
    for line in wrap_text(text, font, size, width):
        pdf.drawString(x, y, line)
        y -= leading
    return y


def draw_bullets(
    pdf: canvas.Canvas,
    bullets: tuple[str, ...],
    x: float,
    y: float,
    width: float,
    *,
    size: float = 10,
    leading: float = 15,
) -> float:
    for bullet in bullets:
        pdf.setFillColor(ACCENT)
        pdf.circle(x + 3, y + 3, 2.2, fill=1, stroke=0)
        lines = wrap_text(bullet, "ManualSans", size, width - 17)
        pdf.setFont("ManualSans", size)
        pdf.setFillColor(TEXT)
        for index, line in enumerate(lines):
            pdf.drawString(x + 14, y - index * leading, line)
        y -= len(lines) * leading + 8
    return y


def fit_image(path: Path, box_width: float, box_height: float) -> tuple[float, float]:
    with Image.open(path) as image:
        width, height = image.size
    scale = min(box_width / width, box_height / height)
    return width * scale, height * scale


def draw_screenshot(
    pdf: canvas.Canvas,
    path: Path,
    x: float,
    y: float,
    width: float,
    height: float,
    markers: tuple[Marker, ...] = (),
) -> tuple[float, float, float, float]:
    pdf.setFillColor(PANEL)
    pdf.roundRect(x, y, width, height, 8, fill=1, stroke=0)
    image_width, image_height = fit_image(path, width - 12, height - 12)
    image_x = x + (width - image_width) / 2
    image_y = y + (height - image_height) / 2
    pdf.drawImage(
        str(path),
        image_x,
        image_y,
        image_width,
        image_height,
        preserveAspectRatio=True,
        mask="auto",
    )
    pdf.setStrokeColor(GRID)
    pdf.roundRect(image_x, image_y, image_width, image_height, 4, fill=0, stroke=1)
    for marker in markers:
        marker_x = image_x + image_width * marker.x
        marker_y = image_y + image_height * marker.y
        pdf.setFillColor(RED)
        pdf.circle(marker_x, marker_y, 9, fill=1, stroke=0)
        pdf.setFillColor(TEXT)
        pdf.setFont("ManualSansBold", 8)
        pdf.drawCentredString(marker_x, marker_y - 3, str(marker.number))
    return image_x, image_y, image_width, image_height


def draw_marker_legend(
    pdf: canvas.Canvas,
    markers: tuple[Marker, ...],
    x: float,
    y: float,
    width: float,
) -> None:
    if not markers:
        return
    column_width = width / 2
    for index, marker in enumerate(markers):
        column = index % 2
        row = index // 2
        marker_x = x + column * column_width
        marker_y = y - row * 18
        pdf.setFillColor(RED)
        pdf.circle(marker_x + 7, marker_y + 2, 6, fill=1, stroke=0)
        pdf.setFillColor(TEXT)
        pdf.setFont("ManualSansBold", 6.5)
        pdf.drawCentredString(marker_x + 7, marker_y, str(marker.number))
        draw_lines(
            pdf,
            marker.label,
            marker_x + 18,
            marker_y + 5,
            column_width - 24,
            size=7.5,
            leading=10,
            color=MUTED,
        )


def draw_footer(pdf: canvas.Canvas, section: str, page_number: int) -> None:
    pdf.setStrokeColor(GRID)
    pdf.line(MARGIN, 31, PAGE_WIDTH - MARGIN, 31)
    pdf.setFont("ManualSans", 7.5)
    pdf.setFillColor(MUTED)
    pdf.drawString(MARGIN, FOOTER_Y, f"Motion Studio v1.6.1 · {section}")
    pdf.drawRightString(PAGE_WIDTH - MARGIN, FOOTER_Y, f"{page_number:02d}")


def draw_standard_page(
    pdf: canvas.Canvas,
    spec: PageSpec,
    page_number: int,
    image_paths: dict[str, Path],
) -> None:
    pdf.setFillColor(BG)
    pdf.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
    pdf.setFillColor(ACCENT)
    pdf.roundRect(MARGIN, HEADER_Y - 2, 86, 18, 9, fill=1, stroke=0)
    pdf.setFillColor(BG)
    pdf.setFont("ManualSansBold", 8)
    pdf.drawCentredString(MARGIN + 43, HEADER_Y + 4, spec.section)
    pdf.setFillColor(TEXT)
    pdf.setFont("ManualSansBold", 23)
    pdf.drawString(MARGIN, HEADER_Y - 32, spec.title)
    draw_lines(pdf, spec.subtitle, MARGIN, HEADER_Y - 53, PAGE_WIDTH - 2 * MARGIN, size=9, color=MUTED)

    if spec.layout == "reference":
        draw_reference_content(pdf, spec)
    elif spec.layout == "workflow":
        draw_workflow_content(pdf, spec, image_paths)
    else:
        text_width = 260
        content_y = HEADER_Y - 91
        draw_bullets(pdf, spec.bullets, MARGIN, content_y, text_width)
        if spec.note:
            pdf.setFillColor(PANEL_2)
            pdf.roundRect(MARGIN, 58, text_width, 62, 7, fill=1, stroke=0)
            draw_lines(pdf, spec.note, MARGIN + 12, 102, text_width - 24, size=8.2, leading=12, color=WARN)
        if spec.image:
            image_x = MARGIN + text_width + 18
            image_width = PAGE_WIDTH - MARGIN - image_x
            draw_screenshot(
                pdf,
                image_paths[spec.image],
                image_x,
                128,
                image_width,
                330,
                spec.markers,
            )
            draw_marker_legend(pdf, spec.markers, image_x, 108, image_width)
    draw_footer(pdf, spec.section, page_number)


def draw_reference_content(pdf: canvas.Canvas, spec: PageSpec) -> None:
    x = MARGIN
    y = HEADER_Y - 90
    table_width = PAGE_WIDTH - 2 * MARGIN
    columns = [150, 205, 180, table_width - 535]
    headers = ("类别", "常用属性", "显示单位", "提示")
    rows = (
        ("空间与几何", "位置、长度、半径、宽高", "m", "角度在界面中使用 °"),
        ("运动", "速度、加速度、角速度", "m/s、m/s²、rad/s", "世界 Y 轴向上"),
        ("动力学", "质量、力、劲度、阻尼", "kg、N、N/m、N·s/m", "质量必须为正"),
        ("电磁学", "电荷、电场、磁场", "C、N/C、T", "磁场正值表示出屏"),
        ("材料", "摩擦、弹性", "无量纲", "摩擦 0～5，弹性 0～1"),
        ("记录", "频率、时长、粒子寿命", "Hz、s", "记录与场景存档分离"),
    )
    pdf.setFillColor(PANEL_2)
    pdf.roundRect(x, y - 27, table_width, 30, 5, fill=1, stroke=0)
    cursor_x = x
    for width, header in zip(columns, headers):
        pdf.setFillColor(TEXT)
        pdf.setFont("ManualSansBold", 9)
        pdf.drawString(cursor_x + 10, y - 17, header)
        cursor_x += width
    row_y = y - 58
    for row_index, row in enumerate(rows):
        pdf.setFillColor(PANEL if row_index % 2 == 0 else BG)
        pdf.rect(x, row_y - 16, table_width, 34, fill=1, stroke=0)
        cursor_x = x
        for width, value in zip(columns, row):
            draw_lines(pdf, value, cursor_x + 10, row_y + 5, width - 18, size=8.5, leading=11)
            cursor_x += width
        row_y -= 34
    draw_bullets(pdf, spec.bullets, x, row_y - 12, table_width)


def draw_workflow_content(
    pdf: canvas.Canvas,
    spec: PageSpec,
    image_paths: dict[str, Path],
) -> None:
    x = MARGIN
    y = HEADER_Y - 105
    width = PAGE_WIDTH - 2 * MARGIN
    step_width = (width - 36) / 4
    for index, bullet in enumerate(spec.bullets[:4], start=1):
        step_x = x + (index - 1) * (step_width + 12)
        pdf.setFillColor(PANEL_2)
        pdf.roundRect(step_x, y - 110, step_width, 124, 7, fill=1, stroke=0)
        pdf.setFillColor(ACCENT)
        pdf.circle(step_x + 22, y - 12, 12, fill=1, stroke=0)
        pdf.setFillColor(BG)
        pdf.setFont("ManualSansBold", 10)
        pdf.drawCentredString(step_x + 22, y - 16, str(index))
        draw_lines(pdf, bullet, step_x + 12, y - 43, step_width - 24, size=8.5, leading=12)
    if spec.image:
        draw_screenshot(pdf, image_paths[spec.image], x, 55, width, 275, spec.markers)


def draw_cover(pdf: canvas.Canvas, image_path: Path) -> None:
    pdf.setFillColor(BG)
    pdf.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
    pdf.setFillColor(ACCENT)
    pdf.rect(0, 0, 12, PAGE_HEIGHT, fill=1, stroke=0)
    pdf.setFillColor(TEXT)
    pdf.setFont("ManualSansBold", 34)
    pdf.drawString(48, 448, "Motion Studio")
    pdf.setFont("ManualSansBold", 24)
    pdf.drawString(48, 406, "1.6.1 使用手册")
    draw_lines(
        pdf,
        "二维物理场景编辑、模拟、测量、图像分析与导出",
        48,
        369,
        285,
        size=12,
        leading=18,
        color=MUTED,
    )
    pdf.setFillColor(PANEL_2)
    pdf.roundRect(48, 214, 260, 112, 8, fill=1, stroke=0)
    draw_lines(pdf, "适用版本", 66, 298, 80, font="ManualSansBold", size=9, color=ACCENT)
    draw_lines(pdf, "Motion Studio v1.6.1", 66, 278, 210, size=10)
    draw_lines(pdf, "场景格式", 66, 252, 80, font="ManualSansBold", size=9, color=ACCENT)
    draw_lines(pdf, "schemaVersion 21", 66, 232, 210, size=10)
    draw_screenshot(pdf, image_path, 344, 110, 458, 350)
    pdf.setFont("ManualSans", 8)
    pdf.setFillColor(MUTED)
    pdf.drawString(48, 42, "中文 A4 横版 · 面向首次使用者 · 2026-08-23")
    pdf.drawRightString(PAGE_WIDTH - 40, 42, "Motion Studio")


def draw_toc(pdf: canvas.Canvas, pages: list[PageSpec]) -> None:
    pdf.setFillColor(BG)
    pdf.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
    pdf.setFont("ManualSansBold", 26)
    pdf.setFillColor(TEXT)
    pdf.drawString(MARGIN, HEADER_Y - 15, "目录")
    pdf.setFont("ManualSans", 9)
    pdf.setFillColor(MUTED)
    pdf.drawString(MARGIN, HEADER_Y - 38, "按章节查找功能；页码与 PDF 页面一致。")
    entries: list[tuple[str, int]] = []
    seen: set[str] = set()
    for index, spec in enumerate(pages, start=4):
        if spec.section in seen:
            continue
        seen.add(spec.section)
        entries.append((spec.section, index))
    for index, (section, page_number) in enumerate(entries):
        column = index // 6
        row = index % 6
        x = MARGIN + column * 385
        y = 455 - row * 66
        pdf.setFillColor(PANEL)
        pdf.roundRect(x, y - 37, 360, 48, 7, fill=1, stroke=0)
        pdf.setFillColor(ACCENT if column == 0 else ACCENT_2)
        pdf.setFont("ManualSansBold", 10)
        pdf.drawString(x + 14, y - 8, section)
        pdf.setFont("ManualSansBold", 15)
        pdf.drawRightString(x + 340, y - 17, f"{page_number:02d}")
    draw_footer(pdf, "目录", 3)


def build_specs() -> list[PageSpec]:
    return [
        PageSpec("开始使用", "阅读方式与安全边界", "先建立正确工作流，再逐步使用高级物理。", (
            "本手册按“创建 → 编辑属性 → 模拟 → 测量与图像 → 导出”的顺序组织。首次使用可先读第 4～8 页。",
            "保存场景前确认单位；世界坐标 X 向右、Y 向上，界面角度使用度，场景内部按 SI 保存。",
            "软件适合教学、演示和常规模型验证；科研结论仍需独立推导、误差分析和实验复核。",
            "模拟运行时物理结构会锁定，测量、选择和视图操作仍可使用。",
        ), "empty", note="提示：遇到对象无法编辑，先点击底栏“重置”，再检查场景树中的锁定状态。"),
        PageSpec("界面与视图", "工作区总览", "认识五个主要区域及其关系。", (
            "顶栏：文件、编辑、视图、模拟和帮助菜单。",
            "左侧：自动分列工具栏；顶端选项栏显示当前工具参数。",
            "中央：米制二维画布；右侧：场景树和属性面板；底部：图像面板与播放栏。",
            "面板可停靠、浮动和缩放；播放栏始终固定可见。",
        ), "empty", (
            Marker(1, .13, .94, "菜单与工具选项"), Marker(2, .03, .55, "自动分列工具栏"),
            Marker(3, .47, .50, "二维画布"), Marker(4, .91, .54, "场景与属性"),
            Marker(5, .46, .12, "图像面板与播放栏"),
        )),
        PageSpec("界面与视图", "画布、坐标与缩放", "画布显示的是世界单位，不是屏幕像素。", (
            "红色竖轴为 Y 轴、绿色横轴为 X 轴；左下角方向标记帮助确认坐标。",
            "滚轮围绕鼠标位置缩放；抓手工具或按住空格可平移画布。",
            "网格会随缩放自适应，吸附使用当前显示的最小网格间距。",
            "按 Alt 可临时绕过网格、墙面、物块和旋转吸附。",
        ), "narrow", note="底部状态条显示当前比例和模拟时间。精细模型可提高缩放后再放置。"),
        PageSpec("菜单与设置", "文件菜单与场景文件", "场景、记录和导出文件彼此独立。", (
            "新建、打开、保存、另存和下载场景使用 .motion.json；坏文件不会覆盖当前文档。",
            "图表记录可导出 CSV；运动记录可配置并导出 GIF。",
            "场景文件保存结构和参数，不保存运行轨迹、图表采样或 GIF 帧。",
            "浏览器不能直接覆盖文件时会明确退化为下载。",
        ), "empty", note="建议：重要模型保存多个版本，并在大改前先“另存为”。"),
        PageSpec("菜单与设置", "编辑、全局变量与设置", "设置只影响本机偏好和以后创建的对象。", (
            "编辑菜单包含撤销、重做、复制粘贴、删除、全选、全局变量和设置。",
            "全局变量按顺序定义，例如 a=10、b=a/2；后面的变量可引用前面的变量。",
            "设置窗口管理网格、吸附和新建对象默认值，不遍历修改当前场景。",
            "v1.6.1 固定使用暗色界面；旧主题偏好会统一迁移为暗色。",
        ), "settings", (
            Marker(1, .31, .68, "网格与吸附"), Marker(2, .66, .67, "新建物体默认值"),
            Marker(3, .31, .33, "地面和记录默认值"), Marker(4, .69, .34, "场、粒子源与力"),
        )),
        PageSpec("工具", "选择、移动、旋转与缩放", "编辑操作保持一条原子撤销记录。", (
            "V：点击选择、拖动移动；拖空白框选，Shift 增减选择。绳、杆、弹簧均可框选。",
            "R：拖动旋转手柄；默认按 15° 吸附，Alt 临时关闭吸附。",
            "S：拖四角等比缩放；支持的形状拖四边只缩放 X 或 Y。",
            "画布拖动或缩放公式控制的数值时，会清除受影响绑定；撤销可恢复公式。",
        ), "selected", (
            Marker(1, .44, .57, "选中对象与缩放手柄"), Marker(2, .88, .52, "分类属性标签"),
            Marker(3, .91, .40, "统一数值输入与步进箭头"),
        )),
        PageSpec("工具", "地面工具与地面连接", "直线、圆弧、贝塞尔共享统一解析路径。", (
            "G：拖动创建地面；在顶部选择直线、圆弧或贝塞尔。",
            "J：依次点击两个未占用端点，建立平滑过渡或无形直接接缝。",
            "属性可设置摩擦、弹性、碰撞侧和法线方向；贝塞尔控制点支持公式。",
            "地面可启用传送带并设置正反方向与表面速度。",
        ), "scaled_ground", note="连接过渡不是装饰线：渲染、碰撞和小球持续接触使用同一路径。"),
        PageSpec("工具", "物体工具", "小球、矩形物块和曲面预设都是真实刚体。", (
            "O：点击创建默认小球；选择物块后，从矩形一个角拖到对角生成宽高。",
            "物块可选钢笔自由形状、斜面、四分之一圆滑道、半圆槽等预设。",
            "基本属性可修改颜色；物理属性包括质量、电荷、材料和旋转约束。",
            "初始状态包含位置、角度、速度和角速度；运行前可用公式统一控制。",
        ), "selected", note="关闭旋转只锁定模拟转动，不删除保存的初始角度和初角速度。"),
        PageSpec("工具", "场工具", "有限场和无限场都可输入安全公式。", (
            "F：选择重力、电场或磁场，再绘制矩形、圆/扇形、钢笔或无限区域。",
            "电场只设置 X/Y 分量，两项分别支持全局变量和 t，例如 3a+sin(t)。",
            "重力场使用二维加速度；磁场使用垂直画面的 Bz，正值为出屏。",
            "某一步公式结果非有限时，仅跳过该场并给出去重警告，不传播 NaN。",
        ), "complex", note="场方向图例会以箭头或点/叉显示；布尔场也遵循同一规则。"),
        PageSpec("工具", "粒子源工具", "点源按角度取样，线源沿线取样。", (
            "I：点击创建点源，拖动创建线源；新建粒子默认电荷为 1 C。",
            "点源可设置发射方向、角范围和密度（个/度）；整圆不会重复首尾方向。",
            "连续发射默认关闭；开启后 t=0 首发，按间隔每次发射一个，达到寿命后移除。",
            "连续粒子只显示当前位置；关闭连续模式时保留批量发射和轨迹。",
        ), "magnetic_model", note="默认连续间隔 1 s、寿命 60 s。重置后样本顺序完全一致。"),
        PageSpec("工具", "绳、杆与弹簧", "连接器端点可锚定物体、地面或世界。", (
            "L：依次选择两个端点，并在顶部选择绳、杆或弹簧。",
            "绳可开启碰撞；杆的两端转动语义可分别设置；弹簧固定为零质量。",
            "弹簧点击空白默认创建自由端，只有“固定到当前位置”才成为世界固定点。",
            "端点、长度、质量、半径、材料、劲度和阻尼均可使用全局变量。",
        ), "complex", note="碰撞绳最低质量为 0.001 kg；关闭碰撞后恢复理想零质量最大长度约束。"),
        PageSpec("工具", "力工具", "外加力锚定在局部点，方向以度输入。", (
            "K：点击普通或根布尔刚体，再拖出力的方向和大小。",
            "力大小支持 N 单位公式；方向以度为单位，例如 45+10*sin(t)。",
            "局部锚点随物体平移和旋转；偏心力会产生真实转矩。",
            "运行时公式无效只跳过本步该力，并显示去重警告。",
        ), "runtime", note="力的 0° 指向世界 X 轴正方向，逆时针为正。"),
        PageSpec("工具", "测量工具", "一个工具格子包含四个运行时可用的子工具。", (
            "M：启用上次使用的测量子工具；悬停菜单可选记号笔、直尺、量角器和测力计。",
            "记号笔保存世界坐标折线；直尺选两点；量角器依次选边点、顶点和边点。",
            "测力计点击物体一点，分解重力、场力、磁场力、库仑力、外加力和约束力。",
            "分项箭头按比例绘制，最终合力加粗；面板和画布使用同一图例。",
        ), "runtime", (
            Marker(1, .29, .52, "记号笔"), Marker(2, .38, .37, "直尺"),
            Marker(3, .53, .44, "量角器"), Marker(4, .90, .38, "受力分析面板"),
        )),
        PageSpec("属性与公式", "属性面板分类", "从基本到高级逐层编辑，切换对象前会提交合法草稿。", (
            "基本：名称、类型、颜色；变换：位置和角度；几何：尺寸与控制点。",
            "物理：质量、电荷、材料、场强、连接参数；初始状态：速度和角速度。",
            "高级：旋转、连续碰撞等低频选项；模拟开始后物理参数锁定。",
            "输入非法草稿后切换对象会恢复原值，不会把草稿串到另一个实体。",
        ), "selected", note="单位、公式文本和“= 当前值”分区显示，长公式不会覆盖单位。"),
        PageSpec("属性与公式", "全局变量和静态属性公式", "同一符号可驱动不同对象的不同属性。", (
            "在“编辑 → 全局变量…”新增 a=10；质量输入 3a 得到 30 kg。",
            "静态属性允许四则运算、幂、括号、隐式乘法及常用函数，但不允许 t。",
            "点击上下箭头默认按显示单位加减 1；公式会规范化为 (3a)+1，并保持绑定。",
            "修改变量会原子重算全部绑定；任何非法范围都会拒绝整次应用。",
        ), "selected", note="变量名以英文字母开头；pi、e、t 和函数名是保留字。"),
        PageSpec("属性与公式", "时变公式", "场和力在每个逻辑固定步起点求值。", (
            "电场 X/Y 分量、重力/磁场强度、力大小和力方向可使用时间 t。",
            "示例：Ex=10*cos(t)，Ey=10*sin(t)；力方向=45+10*sin(t) 度。",
            "暂停不会推进 t；重置后从 t=0 重新计算，结果可复现。",
            "除零、无效开方或非有限结果不会污染物理世界。",
        ), "complex", note="时变表达式显示 t=0 的当前解析值，便于在运行前检查初始条件。"),
        PageSpec("场景树与布尔", "场景树、可见、锁定与模拟", "三种状态各自独立，不能互相替代。", (
            "场景树第一项位于画布最前方；拖动可改变根顺序。",
            "眼睛只控制显示；锁定只禁止编辑；“参与模拟”才决定物理是否启用。",
            "删除实体使用可撤销命令，并级联清理连接器、力和失效选择。",
            "布尔来源嵌套显示在结果节点中；父结果优先且父锁定递归生效。",
        ), "boolean_wide", note="隐藏对象仍可能影响运动，这是设计行为；需要停用时请关闭“参与模拟”。"),
        PageSpec("场景树与布尔", "并集、交集与差集", "布尔树保存来源和运算，派生几何只存在于运行时。", (
            "选择两个兼容物体或同类有限场后点击“布尔组合”。",
            "并集保留任一来源区域；交集只保留重叠；差集按上方减下方计算。",
            "布尔物体可覆盖总质量、电荷、摩擦、弹性和初始状态；场布尔可统一场强。",
            "移动或旋转整棵结果使用缓存快速路径；编辑来源才重新计算 CSG。",
        ), "boolean_scale", (
            Marker(1, .43, .52, "布尔结果轮廓"), Marker(2, .84, .56, "递归来源树"),
            Marker(3, .91, .39, "结果级覆盖属性"),
        )),
        PageSpec("场景树与布尔", "布尔场强与方向图例", "场布尔覆盖会转换为均匀场。", (
            "来源模式沿用各来源场定义；统一模式保存一个结果级均匀场。",
            "电场统一覆盖只输入 X/Y；重力输入 X/Y；磁场输入 Bz。",
            "方向箭头、点或叉只绘制在真实布尔结果区域，孔洞不显示场。",
            "布尔场数值覆盖也可使用全局变量和受控属性公式。",
        ), "boolean_narrow", note="空交集或空差集会明确显示原因，不会创建不可见但仍参与物理的区域。"),
        PageSpec("模拟与记录", "播放、暂停、单步、重置与倍速", "倍速不会改变固定步长。", (
            "P 播放/暂停；句点单步；Shift+R 重置；底栏可选播放倍速。",
            "对外时间步固定为 1/120 s；倍速通过每秒执行更多固定步实现。",
            "暂停保持传送带标记点、连续粒子和图表时间；重置回到 t=0。",
            "复杂弹簧和高曲率路径可触发统一内部子步，但整个世界仍共享时间线。",
        ), "complex", note="不要通过增大 dt 追求速度；这会直接破坏碰撞和场边界精度。"),
        PageSpec("模拟与记录", "长时间运行与记录边界", "v1.6.1 的历史和活动粒子都有明确生命周期。", (
            "物体轨迹、连接器节点和连续粒子使用分块/环形结构，运行越久不会反复复制全部历史。",
            "连续粒子达到寿命后移除，因此活动数量约由寿命/间隔决定。",
            "GIF 粒子记录没有 512 个上限；公开遥测预算为 512 MiB。",
            "预算满时淘汰最旧记录并提示实际可导出时间范围，不影响当前模拟。",
        ), "complex", note="仍保留 200 个刚体、512 个连接器节点、像素帧和编码输出等安全限制。"),
        PageSpec("图像与导出", "图像面板与多个坐标系", "最多建立 8 张独立坐标系卡片。", (
            "每张卡片可选横纵轴、添加多个物体并独立缩放。",
            "纵轴可选择位置、速度、加速度、角度、力、动能等预设量。",
            "也可使用量纲检查的安全公式和 @A.x 形式的跨物体引用。",
            "曲线可单独设置颜色、线型和线宽；十字提示显示统一格式化数值。",
        ), "complex", (
            Marker(1, .68, .32, "多坐标系卡片"), Marker(2, .82, .62, "曲线设置"),
            Marker(3, .64, .06, "播放和时间"),
        )),
        PageSpec("图像与导出", "CSV 导出", "CSV 适合继续在表格或统计软件中分析。", (
            "单张坐标系导出宽表：同一时间行包含所选曲线。",
            "“导出全部”生成长表：坐标系、系列、时间和数值按行组织。",
            "记录频率与时长在场景属性中设置；修改只影响之后的采样。",
            "常量数据会获得稳定的非零坐标范围，不因浮点尾数抖动。",
        ), "complex", note="导出前先运行足够时间，并检查曲线图例与单位是否符合预期。"),
        PageSpec("图像与导出", "GIF 配置、预览与裁剪", "导出窗口冻结一份记录快照，不继续推进模拟。", (
            "选择开始/结束时间并拖动播放头预览最终裁切区间。",
            "设置分辨率、FPS、成片倍速、网格和透明背景。",
            "可为普通物体添加轨迹、速度和合力辅助线；连续粒子只显示位置。",
            "导出期间其他工作区和快捷键会锁定；取消会释放资源。",
        ), "gif", (
            Marker(1, .38, .72, "时间范围与播放头"), Marker(2, .31, .37, "画面与编码设置"),
            Marker(3, .72, .47, "最终成片预览"), Marker(4, .86, .12, "导出按钮"),
        )),
        PageSpec("图像与导出", "保存、打开与恢复", "正式存档、自动草稿和运行记录是三套不同数据。", (
            "保存前写入当前 appVersion 和 schemaVersion，并执行结构校验。",
            "自动草稿保存在 IndexedDB，意外刷新后可恢复；它不能替代正式保存。",
            "格式 20 会确定性迁移到 21；格式 11 或更早的旧 layers 结构被拒绝。",
            "未知、过大、损坏或非法公式文件不会覆盖当前文档。",
        ), "empty", note="跨设备传递场景时，请同时保留 .motion.json；GIF 和 CSV 不能还原模型。"),
        PageSpec("工作流", "推荐建模流程", "四步完成一个可验证、可回退的模型。", (
            "先画几何并确认米制尺寸、坐标和吸附。",
            "再设置质量、材料、场、连接器和初始状态。",
            "单步检查初始受力，短时播放观察方向与边界。",
            "最后添加图像、测量和导出；保存一份已验证场景。",
        ), "empty", layout="workflow"),
        PageSpec("工作流", "快捷键速查", "输入框获得焦点时，工具快捷键不会抢占输入。", (
            "V 选择移动；R 旋转；S 对象缩放；H 抓手；Z 画布缩放。",
            "G 地面；J 地面连接；O 物体；F 场；L 连接器；I 粒子源；K 力。",
            "M 记号笔/测量入口；U 直尺；A 量角器；D 测力计。",
            "Ctrl+Z/Y 撤销重做；Ctrl+C/V 复制粘贴；Delete 删除；P 播放暂停。",
        ), "narrow", note="按 Esc 可取消当前工具步骤、拖动或非法草稿。"),
        PageSpec("工作流", "物理口径与精度", "理解离散模型，才能正确解释结果。", (
            "摩擦和弹性均按两接触面的几何平均合成。",
            "弹簧使用对称半冲量和统一子步；无阻尼表示真正无阻尼。",
            "带电粒子在匀强磁场中按解析圆弧推进，跨有限场边界时局部细分。",
            "图表的合力与加速度来自真实物理步，不用滤波隐藏接触尖峰。",
        ), "magnetic_detail", note="出现异常时先简化模型，分别检查单位、方向、边界、摩擦、弹性和时间步。"),
        PageSpec("完整示例", "示例一：抛体与图像", "用图像面板验证水平匀速和竖直匀加速。", (
            "创建小球并设置初速度 X=8 m/s、Y=10 m/s。",
            "创建覆盖轨迹的重力场，设置加速度 (0, -9.80665) m/s²。",
            "建立 x-t、y-t、vy-t 三张曲线；单步确认初始方向后播放。",
            "导出 CSV，检查 x(t) 近似线性、vy(t) 斜率为重力加速度。",
        ), "complex", note="若需要无碰撞理想抛体，请让地面远离运动范围或关闭地面参与模拟。"),
        PageSpec("完整示例", "示例二：不同质量的弹簧小球", "相同弹力下，大质量小球获得更小加速度。", (
            "创建 1 kg 与 5 kg 小球，用两端自由的预压缩弹簧连接。",
            "把弹簧阻尼设为 0，记录两个小球的速度和加速度。",
            "播放后比较：两端弹力大小相等、方向相反；加速度满足 a=F/m。",
            "若曲线相同，先检查选中的图表系列和质量公式是否真正提交。",
        ), "spring", note="v1.6.0 已修复自由端弹簧错误按相同加速度推两球的问题。"),
        PageSpec("完整示例", "示例三：带电粒子电磁偏转", "用分量公式构造随时间旋转的电场。", (
            "创建点粒子源，电荷 1 C、质量 1 kg、速度 4 m/s，角范围设为 0°。",
            "创建电场，令 Ex=2a*cos(t)、Ey=2a*sin(t)，并定义 a=1。",
            "先关闭连续发射观察单条轨迹，再开启连续发射比较不同时刻出生的粒子。",
            "用测力计或图表检查电场力方向，并导出 GIF 展示动态偏转。",
        ), "magnetic_model", note="连续模式只画粒子位置；需要轨迹时暂时关闭连续发射。"),
        PageSpec("完整示例", "示例四：圆形磁场聚焦", "当 mv/(qB) 等于圆场半径时，平行离子束应汇聚。", (
            "创建线源并让离子平行进入圆形磁场；统一使用 SI 单位。",
            "选择 m、v、q、B 和场半径 R，使 mv/(qB)=R。",
            "放大出射区域检查聚焦点；有限场边界会在固定步内局部细分。",
            "若偏差明显，检查线源方向、B 正负、圆心与半径是否使用同一变量。",
        ), "magnetic_detail", note="v1.6.0 的专项回归约束等半径圆形磁场的出射聚焦误差。"),
        PageSpec("完整示例", "示例五：传送带与受力测量", "把接触摩擦、带速和约束力同时可视化。", (
            "创建直线地面并开启传送带，选择方向和 2 m/s 表面速度。",
            "创建有摩擦物块；播放后观察地面标记点沿路径循环。",
            "运行中选择测力计并点击物块，比较重力、接触/约束合力与最终合力。",
            "把摩擦改为 0 后复测：传送带不应再带动物块。",
        ), "runtime", note="传送带暂停时标记点保持位置，重置后回到路径起点。"),
        PageSpec("参考", "常见问题排查", "从界面状态到物理参数逐层缩小问题。", (
            "不能编辑：确认已重置到 0 s、对象未锁定、当前不是只读布尔来源。",
            "公式不生效：按 Enter，检查变量顺序、允许函数、范围和单位。",
            "对象隐藏后仍运动：隐藏只控制显示；关闭“参与模拟”才停用物理。",
            "长期卡顿：检查活动粒子寿命、图表数量、复杂碰撞绳和 GIF 预算提示。",
            "弹跳或增能：先把摩擦、弹性、阻尼和外力分别关闭，逐项恢复定位原因。",
        ), "floating", note="提交问题时附上场景文件、版本号、复现步骤、预期/实际结果和截图。"),
        PageSpec("参考", "单位、范围与输入约定", "所有属性按显示单位求值，再转换为内部 SI。", (
            "上下箭头和键盘 ArrowUp/ArrowDown 默认按显示单位步进 1。",
            "全局变量只用于场景属性；本机新建默认值、图表界面和导出参数不引用变量。",
            "动态目标来自受控注册表，不允许用对象路径访问任意数据。",
        ), layout="reference"),
        PageSpec("参考", "发布检查清单", "保存或分享模型前完成最后复核。", (
            "确认应用版本 1.6.1、场景格式 21，且标题和文件名能说明模型用途。",
            "检查位置、角度、质量、电荷、场强、材料和初始状态的单位。",
            "单步观察初始受力；短时和目标时长分别播放，确认没有 NaN 或警告。",
            "检查图表图例、坐标轴和 CSV；预览 GIF 裁切范围、分辨率、FPS 与辅助线。",
            "正式保存 .motion.json，并把 PDF 手册或关键参数说明随模型一并交付。",
        ), "redocked", note="完成。更多物理口径见“帮助 → 物理模型与近似说明”。"),
    ]


def resolve_image_paths(args: argparse.Namespace) -> dict[str, Path]:
    paths = {
        "empty": SNAPSHOTS / "empty-editor-chromium-win32.png",
        "settings": SNAPSHOTS / "settings-dialog-chromium-win32.png",
        "selected": SNAPSHOTS / "selected-body-chromium-win32.png",
        "runtime": SNAPSHOTS / "runtime-measurements-chromium-win32.png",
        "gif": SNAPSHOTS / "gif-export-dialog-chromium-win32.png",
        "narrow": SNAPSHOTS / "narrow-editor-chromium-win32.png",
        "complex": SNAPSHOTS / "complex-chart-chromium-win32.png",
        "scaled_ground": SNAPSHOTS / "scaled-ground-thickness-chromium-win32.png",
        "boolean_wide": SNAPSHOTS / "boolean-layer-wide-chromium-win32.png",
        "boolean_scale": SNAPSHOTS / "boolean-scale-handles-wide-chromium-win32.png",
        "boolean_narrow": SNAPSHOTS / "boolean-layer-narrow-chromium-win32.png",
        "floating": SNAPSHOTS / "floating-panels-chromium-win32.png",
        "redocked": SNAPSHOTS / "redocked-panels-chromium-win32.png",
    }
    paths["spring"] = args.spring_image if args.spring_image and args.spring_image.exists() else paths["complex"]
    paths["magnetic_model"] = (
        args.magnetic_model_image
        if args.magnetic_model_image and args.magnetic_model_image.exists()
        else paths["complex"]
    )
    paths["magnetic_detail"] = (
        args.magnetic_detail_image
        if args.magnetic_detail_image and args.magnetic_detail_image.exists()
        else paths["complex"]
    )
    missing = [str(path) for path in paths.values() if not path.exists()]
    if missing:
        raise FileNotFoundError(f"缺少手册截图：{missing}")
    return paths


def generate_pdf(image_paths: dict[str, Path]) -> None:
    OUTPUT_PDF.parent.mkdir(parents=True, exist_ok=True)
    PUBLIC_PDF.parent.mkdir(parents=True, exist_ok=True)
    specs = build_specs()
    if len(specs) != 36:
        raise RuntimeError(f"正文页数量异常：{len(specs)}")
    pdf = canvas.Canvas(str(OUTPUT_PDF), pagesize=landscape(A4), pageCompression=1)
    pdf.setTitle("Motion Studio 1.6.1 使用手册")
    pdf.setAuthor("Motion Studio")
    pdf.setSubject("二维物理场景编辑、模拟、测量、图像与导出")
    pdf.setCreator("Motion Studio documentation build")

    pdf.bookmarkPage("cover")
    pdf.addOutlineEntry("封面", "cover", level=0)
    draw_cover(pdf, image_paths["empty"])
    pdf.showPage()

    pdf.bookmarkPage("reading")
    pdf.addOutlineEntry("阅读说明", "reading", level=0)
    draw_standard_page(pdf, specs[0], 2, image_paths)
    pdf.showPage()

    pdf.bookmarkPage("toc")
    pdf.addOutlineEntry("目录", "toc", level=0)
    draw_toc(pdf, specs[1:])
    pdf.showPage()

    last_section = ""
    for page_number, spec in enumerate(specs[1:], start=4):
        key = f"page-{page_number}"
        pdf.bookmarkPage(key)
        if spec.section != last_section:
            pdf.addOutlineEntry(spec.section, key, level=0)
            last_section = spec.section
        draw_standard_page(pdf, spec, page_number, image_paths)
        pdf.showPage()
    pdf.save()
    shutil.copyfile(OUTPUT_PDF, PUBLIC_PDF)

    pages = len(PdfReader(str(OUTPUT_PDF)).pages)
    if pages != 38:
        raise RuntimeError(f"PDF 页数应为 38，实际为 {pages}")
    if OUTPUT_PDF.read_bytes() != PUBLIC_PDF.read_bytes():
        raise RuntimeError("应用内发布副本与输出 PDF 不一致。")
    print(f"generated={OUTPUT_PDF}")
    print(f"published={PUBLIC_PDF}")
    print(f"pages={pages}")


def main() -> None:
    args = parse_args()
    register_fonts()
    generate_pdf(resolve_image_paths(args))


if __name__ == "__main__":
    main()
