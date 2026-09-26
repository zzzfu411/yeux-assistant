"""Offline extraction contracts; fixtures never access accounts or production data."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "prepare_courses", Path(__file__).resolve().parents[1] / "scripts/prepare-courses.py"
)
prepare = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare)


def utf16_slice(text, start, end):
    return text.encode("utf-16-le")[start * 2:end * 2].decode("utf-16-le")


class CourseExtractionTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.repo = Path(self.directory.name)
        self.output = self.repo / "gse/lab/lab1/private/course-import"

    def write(self, name, data):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data if isinstance(data, bytes) else data.encode("utf-8"))
        return path

    def test_standalone_output_stays_inside_project_private_directory(self):
        self.write('gse/official/lect1.html', '<div class="wiki"><h1>示例</h1><p>正文</p></div>')
        output_root = self.repo / 'standalone/private/course-import'
        specs = [('gse/official/lect1.html', 'gse', '示例')]
        bundle = prepare.prepare_bundle(self.repo, output_root, specs=specs, output_root=output_root)
        self.assertEqual(len(bundle['documents']), 1)
        self.assertTrue((output_root / 'bundle.json').is_file())
        with self.assertRaises(prepare.PreparationError):
            prepare.prepare_bundle(self.repo, self.repo / 'gse/official', specs=specs, output_root=output_root)

    def test_only_main_html_and_original_ai_annotation_are_extracted(self):
        raw = '''<html><base href="https://jyywiki.cn/GSE/2026/lect1.md">
        <nav>不要导入导航</nav><form>token SECRET</form>
        <div class="wiki other"><h1>课程标题</h1><div><p>中文 <strong>重点</strong></p>
        <pre><code>  a = 1\n  print(a)\n```</code></pre>
        <a href="lab1.md">实验</a><span class="aigc">老师标注的补充</span>
        <img alt="关系图" src="data:image/png;base64,PRIVATE_PAYLOAD">
        <span class="katex"><span>重复视觉公式</span><math><annotation encoding="application/x-tex">x^2</annotation></math></span>
        </div></div><script>不要执行脚本</script></html>'''.encode()
        title, body, pages, warnings, _ = prepare.extract_html(raw, "fallback")
        self.assertEqual(title, "课程标题")
        self.assertIn("中文 **重点**", body)
        self.assertIn("  a = 1\n  print(a)", body)
        self.assertIn("````", body)
        self.assertIn("https://jyywiki.cn/GSE/2026/lab1.md", body)
        self.assertIn("[课件标注：AI 补充] 老师标注的补充", body)
        self.assertIn("$x^2$", body)
        self.assertIn("[原文图片：关系图]", body)
        for excluded in ("不要导入导航", "SECRET", "PRIVATE_PAYLOAD", "不要执行脚本", "重复视觉公式"):
            self.assertNotIn(excluded, body)
        self.assertTrue(warnings)
        self.assertEqual(pages[0]["end"], prepare.utf16_length(body))

    def test_slides_json_and_non_bmp_offsets_exclude_demo_javascript(self):
        entries = ["<h1>第一张 😀</h1><p>原文一</p>", "<h1>第二张</h1><p>原文二 🚀</p>"]
        raw = ('<script id="slides-data" type="application/json">' + json.dumps(entries)
               + '</script><div id="pager">1 / 2</div><script>DEMO_LONG_CONTENT</script>').encode()
        _, body, pages, _, _ = prepare.extract_html(raw, "课件")
        self.assertEqual(len(pages), 2)
        self.assertEqual(pages[0]["end"], pages[1]["start"])
        self.assertEqual(pages[-1]["end"], prepare.utf16_length(body))
        self.assertIn("原文一", utf16_slice(body, pages[0]["start"], pages[0]["end"]))
        self.assertIn("原文二 🚀", utf16_slice(body, pages[1]["start"], pages[1]["end"]))
        self.assertNotIn("DEMO_LONG_CONTENT", body)
        self.assertNotIn("1 / 2", body)

    def test_ambiguous_or_unrecognized_html_fails_closed(self):
        for raw in (b"<body>not official source</body>",
                    b'<div class="wiki">one</div><div class="wiki">two</div>',
                    b'<script id="slides-data" type="application/json">[42]</script>'):
            with self.assertRaises(prepare.PreparationError):
                prepare.extract_html(raw, "title")

    def test_allowlist_rejects_answers_exams_generated_notes_and_path_escape(self):
        self.assertTrue(prepare.source_allowed("database/slides/exp_of_ER_1.pdf"))
        self.assertEqual(len(prepare.COURSE_FILES), 26)
        for name in ("database/notes/database_00.md", "database/slides/database_01_sol.pdf",
                     "se/past/exams/test.pdf", "se/slides/答案.ppt", "../database/slides/database_00.pdf",
                     "/database/slides/database_00.pdf", "gse/official/lect5.html",
                     "database\\slides\\database_00.pdf"):
            self.assertFalse(prepare.source_allowed(name), name)
        with patch.object(Path, "read_bytes", side_effect=AssertionError("must not read excluded files")):
            bundle = prepare.prepare_bundle(self.repo, self.output, specs=[("se/past/exams/test.pdf", "se", "exam")])
        self.assertEqual(bundle["documents"], [])
        self.assertEqual(len(bundle["skipped"]), 1)

    def test_lfs_pointer_is_rejected_without_extracting_or_creating_asset(self):
        name = "database/slides/database_00.pdf"
        self.write(name, b"version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 123\n")
        with patch.object(prepare, "extract_source", side_effect=AssertionError("must not parse pointer")):
            bundle = prepare.prepare_bundle(self.repo, self.output, specs=[(name, "database", "title")])
        self.assertEqual(bundle["documents"], [])
        self.assertIn("LFS pointer", bundle["skipped"][0]["reason"])
        self.assertFalse((self.output / "assets").exists())

    def test_bundle_is_idempotent_and_asset_is_exact_original(self):
        name = "gse/official/lect1.html"
        original = b'<div class="wiki"><h1>Title</h1><p>Full original text</p></div>'
        path = self.write(name, original)
        first = prepare.prepare_bundle(self.repo, self.output, specs=[(name, "gse", "title")])
        before_bundle = (self.output / "bundle.json").read_bytes()
        before_mtime = (self.output / "bundle.json").stat().st_mtime_ns
        second = prepare.prepare_bundle(self.repo, self.output, specs=[(name, "gse", "title")])
        self.assertEqual(first, second)
        self.assertEqual((self.output / "bundle.json").read_bytes(), before_bundle)
        self.assertEqual((self.output / "bundle.json").stat().st_mtime_ns, before_mtime)
        self.assertEqual(path.read_bytes(), original)
        metadata = first["documents"][0]["metadata"]
        self.assertEqual(metadata["originHash"], prepare.sha256(original))
        self.assertEqual(metadata["assetKey"], prepare.sha256(original) + ".html")
        self.assertEqual((self.output / "assets" / metadata["assetKey"]).read_bytes(), original)

    def test_oversize_document_reports_error_without_truncation_or_asset(self):
        name = "gse/official/lect1.html"
        self.write(name, '<div class="wiki"><h1>完整正文</h1><p>' + "中文" * 30 + "</p></div>")
        bundle = prepare.prepare_bundle(self.repo, self.output, specs=[(name, "gse", "title")], max_bytes=32)
        self.assertEqual(bundle["documents"], [])
        self.assertIn("拒绝截断", bundle["skipped"][0]["reason"])
        self.assertFalse((self.output / "assets").exists())

    def test_original_mutation_prevents_publishing_new_bundle(self):
        name = "gse/official/lect1.html"
        path = self.write(name, b"original")
        self.output.mkdir(parents=True)
        previous = b'{"version":1,"previous":true}'
        (self.output / "bundle.json").write_bytes(previous)

        def mutate(*args):
            path.write_bytes(b"changed concurrently")
            return "title", "body", [], [], "fixture"

        with patch.object(prepare, "extract_source", side_effect=mutate):
            with self.assertRaisesRegex(prepare.PreparationError, "哈希核对失败"):
                prepare.prepare_bundle(self.repo, self.output, specs=[(name, "gse", "title")])
        self.assertEqual((self.output / "bundle.json").read_bytes(), previous)

    def test_symlink_cannot_point_to_answers(self):
        answer = self.write("se/past/answers.txt", "do not read")
        path = self.repo / "gse/official/lect1.html"
        path.parent.mkdir(parents=True)
        path.symlink_to(answer)
        bundle = prepare.prepare_bundle(self.repo, self.output, specs=[("gse/official/lect1.html", "gse", "title")])
        self.assertIn("符号链接", bundle["skipped"][0]["reason"])
        self.assertEqual(bundle["documents"], [])

    def test_output_cannot_overwrite_course_directory(self):
        with self.assertRaisesRegex(prepare.PreparationError, "输出目录"):
            prepare.prepare_bundle(self.repo, self.repo / "database/slides", specs=[])

    def test_office_conversion_receives_only_a_temporary_copy(self):
        raw = b"mock PPT original bytes"
        seen = []

        def convert(copy, extension, directory, executable):
            self.assertEqual(copy.read_bytes(), raw)
            self.assertNotIn("cloud-3be", str(copy))
            self.assertEqual(extension, "pptx")
            seen.append(copy)
            return directory / "result.pptx"

        with patch.object(prepare, "convert_office", side_effect=convert), patch.object(
            prepare, "extract_pptx", return_value=("title", "body", [], [], "mock")
        ):
            prepare.extract_source("se/slides/lixuandong-classic/part11.ppt", raw, "title", "soffice")
        self.assertEqual(len(seen), 1)
        self.assertFalse(seen[0].exists())

    def test_pptx_extracts_text_table_notes_and_unicode_page_ranges(self):
        from pptx import Presentation
        from pptx.util import Inches

        presentation = Presentation()
        first = presentation.slides.add_slide(presentation.slide_layouts[6])
        box = first.shapes.add_textbox(0, 0, Inches(4), Inches(2))
        box.text_frame.text = "原文标题 😀\n第二行"
        table = first.shapes.add_table(1, 2, 0, Inches(2), Inches(4), Inches(1)).table
        table.cell(0, 0).text = "关系 A"
        table.cell(0, 1).text = "关系 B"
        first.notes_slide.notes_text_frame.text = "原作者备注"
        second = presentation.slides.add_slide(presentation.slide_layouts[6])
        group = second.shapes.add_group_shape()
        group.shapes.add_textbox(0, 0, Inches(4), Inches(2)).text_frame.text = "组合图中的文字"
        path = self.repo / "fixture.pptx"
        presentation.save(path)
        _, body, pages, warnings, _ = prepare.extract_pptx(path, "title")
        for text in ("原文标题 😀", "第二行", "关系 A", "关系 B", "原作者备注", "组合图中的文字"):
            self.assertIn(text, body)
        self.assertEqual(len(pages), 2)
        self.assertIn("组合图中的文字", utf16_slice(body, pages[1]["start"], pages[1]["end"]))
        self.assertTrue(warnings)

    def test_docx_keeps_chinese_text_numbering_and_no_invented_page_numbers(self):
        from docx import Document

        document = Document()
        document.add_paragraph("软件文档编写指南")
        document.add_paragraph("文档的范围和目的")
        document.add_table(rows=1, cols=2).cell(0, 1).text = "表格中的要求"
        document.sections[0].header.paragraphs[0].text = "原作者页眉"
        path = self.repo / "fixture.docx"
        document.save(path)
        exported = self.write("export.txt", "软件文档编写指南\n一． 文档的范围和目的\n表格中的要求\n")
        with patch.object(prepare, "convert_office", return_value=exported):
            _, body, pages, warnings, _ = prepare.extract_docx(path, "title", self.repo / "text", "soffice")
        self.assertIn("一． 文档的范围和目的", body)
        self.assertIn("表格中的要求", body)
        self.assertIn("原作者页眉", body)
        self.assertEqual(pages, [])
        self.assertTrue(any("没有可靠" in item for item in warnings))

    def test_docx_garbled_or_missing_text_export_is_rejected(self):
        from docx import Document

        document = Document()
        document.add_paragraph("软件文档编写指南")
        document.add_paragraph("原文段落不能被丢弃")
        path = self.repo / "fixture.docx"
        document.save(path)
        for text in ("软软软软软软软软", "软件文档编写指南"):
            exported = self.write("export.txt", text)
            with patch.object(prepare, "convert_office", return_value=exported):
                with self.assertRaisesRegex(prepare.PreparationError, "全文核对"):
                    prepare.extract_docx(path, "title", self.repo / "text", "soffice")


if __name__ == "__main__":
    unittest.main()
