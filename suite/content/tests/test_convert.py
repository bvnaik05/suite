import base64
import json
import os
import tempfile
from pathlib import Path
from unittest.mock import patch

import frappe
from frappe.tests import UnitTestCase

from suite.content import capacity, checker, convert

LEGACY = {"content": None, "html": "<p>a</p>", "collab": 0, "ycomments": None}
GOOD = {
    "kind": "converted",
    "state": base64.b64encode(b"\x01\x02").decode(),
    "from": "html",
    "dropped": [{"kind": "noise", "name": "spellcheck"}],
    "anchors": {"thread-1": "anchor-1"},
    "threads": [{"key": "k1", "anchor": "anchor-1", "comments": []}],
    "version": "1",
}


class TestConvert(UnitTestCase):
    def setUp(self):
        if not checker.usable_node(convert.NODE_MIN):
            minimum = ".".join(map(str, convert.NODE_MIN))
            reason = f"needs Node {minimum}+"
            # A skip in CI would leave the job green with a runner never run
            if os.environ.get("CI"):
                self.fail(reason)

            self.skipTest(reason)

        job_patch = patch.object(frappe.local, "job", frappe._dict(job_name="test_convert"), create=True)
        job_patch.start()
        self.addCleanup(job_patch.stop)
        self.folder = Path(self.enterContext(tempfile.TemporaryDirectory()))

    def bundle(self, source: str) -> Path:
        bundle = self.folder / "converter.cjs"
        bundle.write_text(source)
        return bundle

    def answering(self, answer) -> Path:
        text = answer
        if not isinstance(answer, str):
            text = json.dumps(answer)

        reply = json.dumps(text)
        return self.bundle(f"process.stdin.resume().on('end', () => process.stdout.write({reply}))")

    def test_reads_a_converted_answer(self):
        result = convert.convert(self.answering(GOOD), "1", LEGACY)
        self.assertEqual(
            result,
            convert.Converted(
                state=b"\x01\x02",
                source="html",
                dropped=[{"kind": "noise", "name": "spellcheck"}],
                anchors={"thread-1": "anchor-1"},
                threads=[{"key": "k1", "anchor": "anchor-1", "comments": []}],
            ),
        )

    def test_passes_on_the_converter_refusing(self):
        for reason in ("check", "too_large", "unreadable-yjs"):
            with self.subTest(reason):
                bundle = self.answering({"kind": "failed", "reason": reason, "version": "1"})
                self.assertEqual(convert.convert(bundle, "1", LEGACY), convert.Refused(reason))

    def test_names_a_child_that_crashes_or_runs_out_of_time(self):
        for name, source, reason in (
            ("exits", "process.exit(3)", "child_crash"),
            ("is killed", "process.kill(process.pid, 'SIGKILL')", "child_crash"),
            ("hangs", "setInterval(() => {}, 1000)", "child_timeout"),
        ):
            with self.subTest(name), patch.object(checker, "TIMEOUT_S", 1):
                self.assertEqual(convert.convert(self.bundle(source), "1", LEGACY), convert.Refused(reason))

    def test_names_an_answer_it_cannot_read(self):
        for name, answer in (
            ("not JSON", "nope"),
            ("not an object", ["converted"]),
            ("another kind", {**GOOD, "kind": "done"}),
            ("a refusal it doesn't know", {"kind": "failed", "reason": "oom", "version": "1"}),
            ("no state", {key: value for key, value in GOOD.items() if key != "state"}),
            ("a state not in base64", {**GOOD, "state": "AQ*I="}),
            ("a state that isn't text", {**GOOD, "state": 12}),
            ("a source it doesn't know", {**GOOD, "from": "docx"}),
            ("dropped not a list", {**GOOD, "dropped": {}}),
            ("dropped holding text", {**GOOD, "dropped": ["pending"]}),
            ("anchors not an object", {**GOOD, "anchors": []}),
            ("an anchor that isn't text", {**GOOD, "anchors": {"thread-1": 1}}),
            ("threads not a list", {**GOOD, "threads": {}}),
        ):
            with self.subTest(name):
                bundle = self.answering(answer)
                self.assertEqual(convert.convert(bundle, "1", LEGACY), convert.Refused("bad_answer"))

    def test_refuses_a_state_over_the_cap(self):
        bundle = self.answering(GOOD)
        self.assertEqual(
            (
                convert.convert(bundle, "1", LEGACY, max_state=2),
                convert.convert(bundle, "1", LEGACY, max_state=1),
            ),
            (
                convert.Converted(b"\x01\x02", "html", GOOD["dropped"], GOOD["anchors"], GOOD["threads"]),
                convert.Refused("bad_answer"),
            ),
        )

    def test_stops_the_run_when_the_bundle_holds_another_version(self):
        for answer in (GOOD, {"kind": "failed", "reason": "check", "version": "1"}):
            with self.subTest(answer["kind"]), self.assertRaises(convert.ConverterChanged):
                convert.convert(self.answering(answer), "2", LEGACY)

    def test_gives_no_answer_without_node_or_the_bundle(self):
        with patch.object(checker, "usable_node", return_value=None):
            self.assertIsNone(convert.convert(self.answering(GOOD), "1", LEGACY))

        self.assertIsNone(convert.convert(self.folder / "missing.cjs", "1", LEGACY))

    def test_sends_the_old_body_with_no_collab_as_0_and_the_cap(self):
        # The child hands back what it read as its one dropped entry
        good = json.dumps(GOOD)
        bundle = self.bundle(
            "let read = ''\n"
            "process.stdin.on('data', (chunk) => (read += chunk)).on('end', () => {\n"
            f"  const answer = {{ ...{good}, dropped: [JSON.parse(read)] }}\n"
            "  process.stdout.write(JSON.stringify(answer))\n"
            "})"
        )
        legacy = {"content": "AQI=", "html": "", "collab": None, "ycomments": "[]"}

        for caps, sent_cap in (({}, capacity.STATE_MAX), ({"max_state": 10}, 10)):
            with self.subTest(sent_cap):
                result = convert.convert(bundle, "1", legacy, **caps)
                self.assertEqual(
                    result.dropped,
                    [{"legacy": {**legacy, "collab": 0}, "maxState": sent_cap}],
                )

    def test_bundle_ready_fails_loudly_on_a_child_that_crashes(self):
        with self.assertRaises(checker.CheckerFailed):
            convert.bundle_ready(self.bundle("process.exit(3)"), "1")
