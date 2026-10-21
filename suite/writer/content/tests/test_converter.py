import os
import tempfile
from pathlib import Path
from unittest.mock import patch

import frappe
from frappe.tests import UnitTestCase

from suite.content import checker, convert
from suite.writer import content as writer_content


class TestConverter(UnitTestCase):
    def setUp(self):
        if not checker.usable_node() or not writer_content.CONVERTER_BUILD.is_file():
            reason = f"needs Node {checker.NODE_MAJOR}+ and the built bundle at {writer_content.CONVERTER_BUILD}; run bench build"
            # A skip in CI would leave the job green with a converter that can't run
            if os.environ.get("CI"):
                self.fail(reason)

            self.skipTest(reason)

        job_patch = patch.object(frappe.local, "job", frappe._dict(job_name="test_converter"), create=True)
        job_patch.start()
        self.addCleanup(job_patch.stop)

    def test_the_built_bundle_holds_the_version_the_server_expects(self):
        self.assertTrue(
            convert.bundle_ready(writer_content.CONVERTER_BUILD, writer_content.CONVERTER_VERSION)
        )

    def test_refuses_a_bundle_with_another_version_or_none(self):
        folder = self.enterContext(tempfile.TemporaryDirectory())
        for name, source in (
            ("stale", "process.stdout.write(JSON.stringify({ version: '0' }))"),
            ("unversioned", "process.stdout.write(JSON.stringify({}))"),
        ):
            bundle = Path(folder) / f"{name}.cjs"
            bundle.write_text(source)
            with self.subTest(name):
                self.assertFalse(convert.bundle_ready(bundle, "1"))

    def test_refuses_a_missing_bundle(self):
        missing = writer_content.CONVERTER_BUILD.with_name("missing.cjs")
        self.assertFalse(convert.bundle_ready(missing, writer_content.CONVERTER_VERSION))
