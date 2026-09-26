#!/usr/bin/env python3
"""Prepare a local, versioned course bundle; never write sources or contact services.

Use the bundled Python (lxml, pypdf and python-pptx) and installed soffice.
Only the explicit source list below is eligible; notes, exercises, answers and
past exams are not crawled. Exit 2 means at least one source could not be prepared.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tempfile
from typing import Any
from urllib.parse import urljoin
from zipfile import ZipFile


MAX_CONTENT_BYTES = 2_000_000
COURSE_NAMES = {"gse": "生成式软件工程", "database": "数据库概论", "se": "软件工程"}
COURSE_FILES = (
    *((f"gse/official/lect{i}.html", "gse", f"GSE 2026 · 第 {i} 讲") for i in range(1, 5)),
    *((f"gse/official/slides{i}.html", "gse", f"GSE 2026 · 第 {i} 讲课件") for i in range(1, 5)),
    ("gse/official/lab1.html", "gse", "GSE 2026 · Lab1"),
    ("database/slides/database_00.pdf", "database", "数据库概论（课程说明）"),
    ("database/slides/database_01.pdf", "database", "第一章 数据库系统概述"),
    ("database/slides/database_02.pdf", "database", "第 2 章 数据模型"),
    ("database/slides/database_03_1.pdf", "database", "第 3 章 关系数据库系统"),
    ("database/slides/database_03_2.pdf", "database", "关系数据库语言 SQL’92 及 DB2 SQL"),
    ("database/slides/exp_of_ER_1.pdf", "database", "数据库概论 · Case Study 1"),
    ("database/slides/exp_of_ER_2.pdf", "database", "数据库概论 · Case Study 2"),
    ("database/slides/database_exp_of_algebra.ppt", "database", "数据库概论 · 关系代数案例"),
    ("se/slides/lixuandong-classic/part11.ppt", "se", "软件工程（part11）"),
    ("se/slides/lixuandong-classic/part12.ppt", "se", "面向对象软件工程（标准建模语言 UML）"),
    ("se/slides/lixuandong-classic/part13.ppt", "se", "软件过程、管理和质量"),
    ("se/slides/lixuandong-classic/part21.ppt", "se", "Software Engineering（part21）"),
    ("se/slides/lixuandong-classic/part22.ppt", "se", "Object-Oriented Software Engineering（UML）"),
    ("se/slides/lixuandong-classic/part23.ppt", "se", "Software Process, Management, and Quality"),
    ("se/slides/lixuandong-classic/part24.ppt", "se", "软件工程中的高级课题"),
    ("se/slides/lixuandong-classic/part25.ppt", "se", "软件开发的新方法（New Methodology）— Agile 方法"),
    ("se/slides/lixuandong-classic/guide.doc", "se", "软件文档编写指南"),
)
ALLOWED_PATHS = frozenset(item[0] for item in COURSE_FILES)
LFS_HEADER = b"version https://git-lfs.github.com/spec/v1"
EXCLUDED = re.compile(
    r"(?:^|[/_.\-\s])(?:answers?|solutions?|sol|exams?|past|notes|exercises)(?:$|[/_.\-\s])"
    r"|答案|解答|往年|试卷|回忆卷",
    re.IGNORECASE,
)


class PreparationError(ValueError):
    pass


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def utf16_length(value: str) -> int:
    """Offsets used by JavaScript String.slice, including non-BMP characters."""
    return len(value.encode("utf-16-le")) // 2


def source_allowed(relative_path: str) -> bool:
    path = PurePosixPath(relative_path)
    return (
        not path.is_absolute()
        and ".." not in path.parts
        and "\\" not in relative_path
        and not EXCLUDED.search(relative_path)
        and relative_path in ALLOWED_PATHS
    )


def page_document(title: str, sections: list[str]) -> tuple[str, list[dict[str, int]]]:
    if not sections:
        raise PreparationError("文档没有页或幻灯片")
    chunks = [f"# {title}\n\n"]
    offset = utf16_length(chunks[0])
    pages = []
    for number, body in enumerate(sections, 1):
        section = f"## 第 {number} 页\n\n{body.strip()}\n\n"
        end = offset + utf16_length(section)
        pages.append({"number": number, "start": offset, "end": end})
        chunks.append(section)
        offset = end
    return "".join(chunks), pages


def _inline_text(value: str | None) -> str:
    return re.sub(r"\s+", " ", value or "")


def _code_fence(text: str) -> str:
    longest = max((len(match[0]) for match in re.finditer(r"`+", text)), default=0)
    return "`" * max(3, longest + 1)


class HtmlMarkdown:
    """Convert selected source HTML, without script execution or network access."""

    def __init__(self, base_url: str = "") -> None:
        self.base_url = base_url
        self.warnings: set[str] = set()

    def children(self, element: Any) -> str:
        value = _inline_text(element.text)
        for child in element:
            value += self.render(child)
            value += _inline_text(child.tail)
        return value

    def render(self, element: Any) -> str:
        if not isinstance(element.tag, str):
            return ""
        tag = element.tag.lower().split("}")[-1]
        if tag in {"script", "style", "nav", "noscript", "form", "button", "input"}:
            return ""
        classes = set(element.get("class", "").split())
        if "katex" in classes or tag == "math":
            tex = element.xpath('.//*[local-name()="annotation" and @encoding="application/x-tex"]')
            if tex:
                return "$" + "".join(tex[0].itertext()) + "$"
            self.warnings.add("部分公式没有 LaTeX 标注；只保留可提取文字，请对照原件。")
        if tag == "img":
            self.warnings.add("HTML 中的图片未作 OCR 或图表语义识别；替代文字不代表完整图意，请对照原件。")
            alt = element.get("alt", "").strip()
            return f"[原文图片：{alt or '无替代文字'}]"
        if tag in {"iframe", "video", "audio", "canvas", "svg"}:
            self.warnings.add("嵌入媒体或矢量图未提取完整语义，请对照原件及其外部资源。")
            return self.children(element) if tag == "svg" else "[原文含嵌入媒体，请对照原件]"
        if tag == "pre":
            raw = "".join(element.itertext()).strip("\n")
            fence = _code_fence(raw)
            return f"\n\n{fence}\n{raw}\n{fence}\n\n"
        if tag == "code":
            raw = "".join(element.itertext())
            fence = "`" * (max((len(m[0]) for m in re.finditer(r"`+", raw)), default=0) + 1)
            return fence + raw + fence
        if tag == "table":
            rows = []
            for row in element.xpath(".//tr"):
                cells = [self.children(cell).strip().replace("\n", "<br>").replace("|", "\\|")
                         for cell in row if isinstance(cell.tag, str) and cell.tag in {"th", "td"}]
                if cells:
                    rows.append("| " + " | ".join(cells) + " |")
            if not rows:
                return self.children(element)
            # HTML row/column spans cannot be faithfully expressed by a simple table.
            if element.xpath('.//*[@rowspan or @colspan]'):
                self.warnings.add("HTML 表格含合并单元格；文字已保留，表格关系请对照原件。")
            return "\n\n" + "\n".join(rows) + "\n\n"
        if tag in {"ul", "ol"}:
            items = []
            counter = int(element.get("start", "1")) if element.get("start", "1").isdigit() else 1
            for child in element:
                if child.tag != "li":
                    continue
                body = self.children(child).strip()
                prefix = f"{counter}. " if tag == "ol" else "- "
                items.append(prefix + body.replace("\n", "\n  "))
                counter += 1
            return "\n\n" + "\n".join(items) + "\n\n"
        body = self.children(element)
        if "aigc" in classes:
            body = "[课件标注：AI 补充] " + body
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            return "\n\n" + "#" * int(tag[1]) + " " + body.strip() + "\n\n"
        if tag in {"p", "div", "section", "article", "figure", "figcaption", "header", "footer"}:
            return "\n\n" + body.strip() + "\n\n"
        if tag == "blockquote":
            return "\n\n" + "\n".join("> " + line for line in body.strip().splitlines()) + "\n\n"
        if tag == "br":
            return "\n"
        if tag == "hr":
            return "\n\n---\n\n"
        if tag in {"b", "strong"}:
            return "**" + body + "**"
        if tag in {"em", "i"}:
            return "*" + body + "*"
        if tag == "a":
            href = urljoin(self.base_url, element.get("href", ""))
            if href.startswith(("https://", "http://", "mailto:", "#")):
                return "[" + body + "](" + href.replace(" ", "%20") + ")"
        if tag == "sup":
            return "^(" + body + ")"
        if tag == "sub":
            return "_(" + body + ")"
        return body

    def convert(self, element: Any) -> str:
        # Do not normalize whitespace inside code fences or silently truncate it.
        return self.render(element).strip()


def extract_html(raw: bytes, fallback_title: str) -> tuple[str, str, list, list, str]:
    from lxml import html

    tree = html.fromstring(raw.decode("utf-8"))
    base = tree.xpath("string(//base/@href)")
    converter = HtmlMarkdown(base)
    payloads = tree.xpath('//script[@id="slides-data" and @type="application/json"]/text()')
    if payloads:
        if len(payloads) != 1:
            raise PreparationError("slides-data 不唯一，拒绝猜测正文")
        slides = json.loads(payloads[0])
        if not isinstance(slides, list) or not slides or not all(isinstance(s, str) for s in slides):
            raise PreparationError("slides-data 不是非空 HTML 字符串列表")
        sections = [converter.convert(html.fragment_fromstring(slide, create_parent="div")) for slide in slides]
        content, pages = page_document(fallback_title, sections)
        title = fallback_title
        method = "lxml: slides-data JSON → 各幻灯片 HTML → Markdown（不执行脚本）"
    else:
        bodies = tree.xpath('//*[contains(concat(" ", normalize-space(@class), " "), " wiki ")]')
        if len(bodies) != 1:
            raise PreparationError("未找到唯一 .wiki 正文，拒绝导入整页导航或脚本")
        body = bodies[0]
        title = body.xpath("string(.//h1)").strip() or fallback_title
        content = converter.convert(body) + "\n"
        pages = [{"number": 1, "start": 0, "end": utf16_length(content)}]
        method = "lxml: 唯一 .wiki 正文 → Markdown（不执行脚本）"
    if not content.strip():
        raise PreparationError("HTML 正文为空")
    return title, content, pages, sorted(converter.warnings), method


def extract_pdf(path: Path, title: str) -> tuple[str, str, list, list, str]:
    from pypdf import PdfReader

    reader = PdfReader(path)
    if reader.is_encrypted and not reader.decrypt(""):
        raise PreparationError("PDF 已加密，不能读取文本层")
    sections = []
    warnings = ["仅提取 PDF 文本层；图片、连线、图表关系和公式排版未作语义识别，请对照原件。"]
    font_dependent_symbols = False
    for number, page in enumerate(reader.pages, 1):
        body = page.extract_text() or ""
        if not body.strip():
            warnings.append(f"第 {number} 页没有可提取文本，可能为图片页；未进行 OCR。")
        if "\ufffd" in body or re.search(r"\(cid:\d+\)", body):
            warnings.append(f"第 {number} 页包含缺失或不可识别字形，请对照原件。")
        font_dependent_symbols = font_dependent_symbols or bool(re.search(r"[\ue000-\uf8ff]", body))
        sections.append(body)
    if not any(s.strip() for s in sections):
        raise PreparationError("PDF 没有可提取文本；需要单独 OCR，未生成空资料")
    if font_dependent_symbols:
        warnings.append("正文含依赖原字体的私用区符号，可能是项目符号或数学符号；含义请对照原件。")
    content, pages = page_document(title, sections)
    return title, content, pages, warnings, "pypdf: 逐页文本层提取，保留原页顺序"


def convert_office(source: Path, extension: str, out_dir: Path, soffice: str) -> Path:
    """Caller passes only a temporary copy, never an original course source."""
    out_dir.mkdir(parents=True, exist_ok=True)
    profile = out_dir / "lo-profile"
    command = [soffice, f"-env:UserInstallation={profile.as_uri()}", "--headless", "--convert-to",
               extension, "--outdir", str(out_dir), str(source)]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=180, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise PreparationError(f"LibreOffice 转换失败：{type(exc).__name__}") from exc
    converted = out_dir / f"{source.stem}.{extension.split(':', 1)[0]}"
    if result.returncode != 0 or not converted.is_file() or converted.stat().st_size == 0:
        reason = (result.stderr or result.stdout).strip()[:400]
        raise PreparationError(f"LibreOffice 未生成 {extension}：{reason or result.returncode}")
    return converted


def _shape_text(shape: Any, warnings: set[str]) -> list[str]:
    from pptx.enum.shapes import MSO_SHAPE_TYPE

    if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
        return [text for child in shape.shapes for text in _shape_text(child, warnings)]
    blocks = []
    if shape.has_text_frame:
        blocks.extend("  " * paragraph.level + paragraph.text.replace("\v", "\n")
                      for paragraph in shape.text_frame.paragraphs if paragraph.text)
    if shape.has_table:
        for row in shape.table.rows:
            blocks.append("| " + " | ".join(cell.text.replace("\v", "\n").replace("\n", "<br>")
                                             .replace("|", "\\|") for cell in row.cells) + " |")
    if shape.has_chart:
        warnings.add("部分幻灯片含图表；图表数据及关系未完整提取，请对照原件。")
        if shape.chart.has_title and shape.chart.chart_title.has_text_frame:
            blocks.append(shape.chart.chart_title.text_frame.text)
    if shape.shape_type in {MSO_SHAPE_TYPE.PICTURE, MSO_SHAPE_TYPE.LINKED_PICTURE}:
        warnings.add("部分幻灯片含图片；图片中文字未作 OCR，请对照原件。")
    if shape.shape_type in {MSO_SHAPE_TYPE.EMBEDDED_OLE_OBJECT, MSO_SHAPE_TYPE.LINKED_OLE_OBJECT}:
        warnings.add("部分幻灯片含嵌入对象；对象内部文字或公式未完整提取，请对照原件。")
    return blocks


def extract_pptx(path: Path, title: str) -> tuple[str, str, list, list, str]:
    from pptx import Presentation

    presentation = Presentation(path)
    warnings = {"旧 PPT 经 LibreOffice 临时转换；提取文字、表格与备注，图形连线、动画和空间关系需对照原件。"}
    sections = []
    for number, slide in enumerate(presentation.slides, 1):
        blocks = [text for shape in slide.shapes for text in _shape_text(shape, warnings)]
        if slide.has_notes_slide:
            frame = slide.notes_slide.notes_text_frame
            notes = frame.text.strip() if frame is not None else ""
            if notes:
                blocks.append("### 原文备注\n\n" + notes)
        text = "\n\n".join(blocks)
        if not text.strip():
            warnings.add(f"第 {number} 页没有可提取文本，请对照原件；未进行 OCR。")
        if re.search(r"[\ue000-\uf8ff]", text):
            warnings.add("正文含依赖原字体的私用区符号；公式或符号含义请对照原件。")
        sections.append(text)
    if not any(s.strip() for s in sections):
        raise PreparationError("PPT 没有可提取文本；未生成空资料")
    content, pages = page_document(title, sections)
    return title, content, pages, sorted(warnings), "LibreOffice PPT → PPTX（临时副本）；python-pptx 逐页文字/表格/备注"


def extract_docx(path: Path, title: str, out_dir: Path, soffice: str) -> tuple[str, str, list, list, str]:
    from lxml import etree

    # Writer's UTF-8 text filter retains automatic Chinese/Latin numbering. Going
    # through PDF loses CJK mappings in this legacy DOC, despite visually valid glyphs.
    text_path = convert_office(path, "txt:Text (encoded):UTF8", out_dir, soffice)
    body = text_path.read_text(encoding="utf-8-sig").strip()
    if not body:
        raise PreparationError("DOCX 文本为空")
    warnings = ["旧 DOC 经临时 DOCX 提取全文；没有可靠的原件分页，未生成页码锚点。",
                "DOC 的图形、表格排版和公式外观未作语义识别，请对照原件。"]
    normalize = lambda value: re.sub(r"\s+", "", value)
    compact = normalize(body)
    namespace = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    with ZipFile(path) as archive:
        # Reject text export that dropped any main-document paragraph. Include
        # otherwise omitted authored headers/footers/notes as explicitly named blocks.
        parts = ["word/document.xml"] + sorted(name for name in archive.namelist()
            if re.fullmatch(r"word/(?:header\d+|footer\d+|footnotes|endnotes|comments)\.xml", name))
        for part in parts:
            tree = etree.fromstring(archive.read(part))
            paragraphs = ["".join(p.xpath(".//w:t/text()", namespaces=namespace))
                          for p in tree.xpath(".//w:p", namespaces=namespace)]
            missing = [p for p in paragraphs if normalize(p) and normalize(p) not in compact]
            if missing and part == "word/document.xml":
                raise PreparationError(f"DOCX 全文核对发现 {len(missing)} 段未被完整导出，拒绝丢失正文")
            if missing:
                body += f"\n\n### 原文附属文字（{PurePosixPath(part).stem}）\n\n" + "\n\n".join(missing)
                compact = normalize(body)
                warnings.append("原文的页眉、页脚或批注等附属文字单独保留；位置请对照原件。")
    return title, f"# {title}\n\n{body}\n", [], list(dict.fromkeys(warnings)), (
        "LibreOffice DOC → DOCX → UTF-8 文本（临时副本，保留自动编号）；与 DOCX 全文逐段核对"
    )


def extract_source(relative_path: str, raw: bytes, title: str, soffice: str) -> tuple[str, str, list, list, str]:
    extension = PurePosixPath(relative_path).suffix.lower()[1:]
    if extension == "html":
        return extract_html(raw, title)
    with tempfile.TemporaryDirectory(prefix="course-extract-") as directory:
        temp = Path(directory)
        copy = temp / PurePosixPath(relative_path).name
        copy.write_bytes(raw)
        if extension == "pdf":
            return extract_pdf(copy, title)
        if extension == "ppt":
            converted = convert_office(copy, "pptx", temp / "pptx", soffice)
            return extract_pptx(converted, title)
        if extension == "doc":
            docx = convert_office(copy, "docx", temp / "docx", soffice)
            return extract_docx(docx, title, temp / "text", soffice)
    raise PreparationError(f"不支持格式：{extension}")


def atomic_write(path: Path, data: bytes) -> None:
    if path.is_file() and path.read_bytes() == data:
        return
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temp = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def prepare_bundle(repo_root: Path, output: Path, *, specs=COURSE_FILES,
                   soffice: str = "soffice", max_bytes: int = MAX_CONTENT_BYTES,
                   output_root: Path | None = None) -> dict:
    repo_root, output = repo_root.resolve(), output.resolve()
    expected_output = (output_root or repo_root / "gse/lab/lab1/private/course-import").resolve()
    if output != expected_output and expected_output not in output.parents:
        raise PreparationError("输出目录必须位于指定的私人导入目录，避免覆盖课程原件")
    bundle: dict[str, Any] = {"version": 1, "documents": [], "skipped": []}
    hashes_before: dict[str, str] = {}
    for relative_path, course, fallback_title in specs:
        try:
            if not source_allowed(relative_path):
                raise PreparationError("不在课程原件白名单内，或属于答案/试卷/笔记/练习，拒绝读取")
            source = repo_root / relative_path
            if source.resolve() != source:
                raise PreparationError("原件包含符号链接，拒绝跟随到白名单之外")
            raw = source.read_bytes()
            origin_hash = sha256(raw)
            hashes_before[relative_path] = origin_hash
            if raw.lstrip().startswith(LFS_HEADER):
                raise PreparationError("这是 Git LFS pointer，原件实体未就绪")
            if not raw:
                raise PreparationError("原件为空")
            title, content, pages, warnings, method = extract_source(relative_path, raw, fallback_title, soffice)
            if len(content.encode("utf-8")) > max_bytes:
                raise PreparationError(f"完整正文超过 {max_bytes} 字节上限；拒绝截断，请拆分来源")
            if sha256(source.read_bytes()) != origin_hash:
                raise PreparationError("提取期间原件发生变化，拒绝保存此结果")
            extension = source.suffix.lower()[1:]
            asset_key = f"{origin_hash}.{extension}"
            asset = output / "assets" / asset_key
            if asset.is_file() and sha256(asset.read_bytes()) != origin_hash:
                raise PreparationError("已有原件副本与内容摘要不一致，拒绝覆盖")
            atomic_write(asset, raw)
            bundle["documents"].append({
                "key": relative_path,
                "title": title,
                "content": content,
                "metadata": {"course": course, "courseName": COURSE_NAMES[course],
                             "originPath": relative_path, "originHash": origin_hash,
                             "format": extension, "extraction": method, "warnings": warnings,
                             "pages": pages, "assetKey": asset_key},
            })
        except Exception as exc:
            # Each adapter may raise its own parser exception; retain an explicit
            # skipped item rather than silently losing a source or aborting midway.
            bundle["skipped"].append({"path": relative_path, "reason": str(exc)})
    # Recheck all read originals at the end, including files that failed extraction.
    for relative_path, expected in hashes_before.items():
        try:
            matches = sha256((repo_root / relative_path).read_bytes()) == expected
        except OSError:
            matches = False
        if not matches:
            raise PreparationError(f"原文件哈希核对失败：{relative_path}；没有发布新 bundle")
    payload = (json.dumps(bundle, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
    atomic_write(output / "bundle.json", payload)
    return bundle


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    output_root = Path(__file__).resolve().parents[1] / "private/course-import"
    parser.add_argument("--repo-root", type=Path, required=True, help="课程资料根目录，包含 gse/、database/、se/")
    parser.add_argument("--output", type=Path, help="默认本项目 private/course-import，只允许其内部目录")
    parser.add_argument("--soffice", default=shutil.which("soffice") or "soffice")
    args = parser.parse_args()
    output = args.output or output_root
    try:
        bundle = prepare_bundle(args.repo_root, output, soffice=args.soffice, output_root=output_root)
    except (OSError, PreparationError) as exc:
        parser.exit(2, f"准备失败：{exc}\n")
    summary = {"bundle": str(output.resolve() / "bundle.json"),
               "documents": len(bundle["documents"]),
               "pages": sum(len(doc["metadata"]["pages"]) for doc in bundle["documents"]),
               "byCourse": {course: sum(doc["metadata"]["course"] == course for doc in bundle["documents"])
                            for course in COURSE_NAMES},
               "warnings": sum(len(doc["metadata"]["warnings"]) for doc in bundle["documents"]),
               "skipped": bundle["skipped"]}
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 2 if bundle["skipped"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
