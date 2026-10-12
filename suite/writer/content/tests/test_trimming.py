from suite.composition import content as routes
from suite.writer.content.tests.support import CheckpointCase, call_route, read_frame


class TestWriterTrimming(CheckpointCase):
    def pull(self, node: str, since: int) -> tuple[str, list[int]]:
        pulled = call_route(lambda node: routes.updates_get(node, since=str(since)), node).get_data()
        header, rows = read_frame(pulled)
        return header["state"], [rev for rev, _payload in rows]

    def test_a_tab_behind_the_trimmed_rows_is_told_to_rebuild(self):
        node = self.new_document()
        self.type_into(node, ["one ", "two ", "three"])
        self.set_doc(node, trimmed_rev=2)

        self.assertEqual(self.pull(node, 1), ("rebuild", []))
        self.assertEqual(self.pull(node, 2), ("live", [3]))
