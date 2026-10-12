import { expect, test } from "../../fixtures/test";
import {
	expectConverged,
	expectSaved,
	openForCollab,
	serverBlocks,
	saveNamedVersion,
	typeParagraph,
} from "../../helpers/collab";
import { discardNode } from "../../helpers/drive";
import { createWriterDocument, openWriterDocument, uniqueWriterTitle } from "../../helpers/writer";

test.describe("Writer collaboration", () => {
	let node = "";

	test.beforeEach(async ({ owner, collaborator, run, testApi }, testInfo) => {
		const title = uniqueWriterTitle(run.run_id, `collab ${testInfo.title}`);
		node = (await createWriterDocument(owner.page.request, title)).name;
		await openForCollab(testApi, owner.page.request, node, collaborator.user.user);
	});

	test.afterEach(async ({ owner }) => {
		await discardNode(owner.context.request, node);
	});

	test("an edit made while another tab previews a version shows after Back to current", async ({
		owner,
		collaborator,
		testApi,
	}) => {
		await openWriterDocument(owner.page, node);
		await typeParagraph(owner.page, "Written before the version");
		await expectSaved(owner.page);
		await saveNamedVersion(owner.context.request, node, "Before the preview");
		await openWriterDocument(collaborator.page, node);

		await owner.page
			.getByRole("button", { name: /versions/i })
			.first()
			.click();
		await owner.page
			.getByRole("complementary", { name: "Versions" })
			.getByRole("button", { name: /^Before the preview/ })
			.click();
		await expect(owner.page.getByText("Viewing Before the preview")).toBeVisible();
		await expect(owner.page.getByLabel("Version preview")).toContainText(
			"Written before the version",
		);

		await typeParagraph(collaborator.page, "Typed during the preview");
		await expectSaved(collaborator.page);
		await expect
			.poll(async () => (await serverBlocks(testApi, node)).join("\n"))
			.toContain("Typed during the preview");

		await owner.page.getByRole("button", { name: "Back to current" }).click();

		await expectConverged(
			testApi,
			node,
			[owner.page, collaborator.page],
			["Written before the version", "Typed during the preview"],
		);
		await expectSaved(owner.page);
		await expect(owner.page.locator(".bg-surface-amber-2")).toHaveCount(0);
	});

	test("the Versions panel takes the table of contents' place on the right and moves the text like it", async ({
		owner,
	}) => {
		const { page } = owner;
		await page.setViewportSize({ width: 1440, height: 900 });
		await openWriterDocument(page, node);
		await typeParagraph(page, "Centred text");
		await page.keyboard.press("Enter");
		await page.keyboard.type("## First heading");
		await page.keyboard.press("Enter");
		await page.keyboard.type("## Second heading");
		await expectSaved(page);
		await saveNamedVersion(owner.context.request, node, "One");
		const showToc = page.getByRole("button", { name: "Show table of contents" });
		if (await showToc.isVisible()) {
			await showToc.click();
		}

		const tocHeading = page.getByText("Table of contents", { exact: true });
		const tocEntry = page.getByRole("link", { name: "First heading" });
		const tocEntryBox = (await tocEntry.boundingBox())!;
		const tocHeadingBox = (await tocHeading.boundingBox())!;
		const tocGap = tocEntryBox.y - tocHeadingBox.y;
		const centredLine = page
			.getByLabel("Document editor")
			.locator("p", { hasText: "Centred text" });
		let lastX = -1;
		await expect
			.poll(async () => lastX === (lastX = (await centredLine.boundingBox())!.x), {
				intervals: [400],
			})
			.toBe(true);
		const restingBox = await centredLine.boundingBox();
		const column = await page.locator("#editor-scroll-container").boundingBox();
		const sampleFrames = () => {
			const line = document.querySelector('[aria-label="Document editor"] p')!;
			const frames: number[][] = [];
			const start = performance.now();
			const sampleUntilDone = (resolve: (frames: number[][]) => void) => {
				const tick = () => {
					const asideWidth = document.querySelector("aside")?.getBoundingClientRect().width ?? 0;
					frames.push([line.getBoundingClientRect().x, asideWidth]);
					if (performance.now() - start < 600) {
						requestAnimationFrame(tick);
					} else {
						resolve(frames);
					}
				};
				requestAnimationFrame(tick);
			};

			return new Promise<number[][]>(sampleUntilDone);
		};
		const sampleMotion = () => page.evaluate(sampleFrames);
		const expectInStep = (frames: number[][]) => {
			expect(frames.some(([, width]) => width > 10 && width < 310)).toBe(true);
			const drift = Math.max(
				...frames.map(([x, width]) => Math.abs(restingBox!.x - x - width / 2)),
			);
			expect(drift).toBeLessThanOrEqual(1);
		};

		const opening = sampleMotion();
		await page
			.getByRole("button", { name: /versions/i })
			.first()
			.click();
		expectInStep(await opening);
		const versionsPanel = page.getByRole("complementary", { name: "Versions" });
		const row = versionsPanel.getByRole("button", { name: /^One/ });
		await expect(row).toBeVisible();
		const panelBox = (await versionsPanel.boundingBox())!;
		expect(panelBox).toMatchObject({ y: column!.y, height: column!.height, width: 320 });
		expect(panelBox.x + panelBox.width).toBe(column!.x + column!.width);
		expect((await centredLine.boundingBox())!.x).toBe(restingBox!.x - 160);
		const headingBox = (await versionsPanel
			.getByRole("heading", { name: "Versions" })
			.boundingBox())!;
		const firstRowBox = (await row.boundingBox())!;
		expect(firstRowBox.x).toBe(headingBox.x);
		expect(firstRowBox.y - headingBox.y).toBe(tocGap);

		await page
			.getByRole("button", { name: /comments/i })
			.first()
			.click();
		const comments = page.getByRole("complementary", { name: "Comments" });
		const inputBox = (await comments.getByPlaceholder("Add a comment").boundingBox())!;
		const commentsHeading = (await comments
			.getByRole("heading", { name: "Comments" })
			.boundingBox())!;
		expect(inputBox.x).toBe(commentsHeading.x);
		expect(inputBox.y - commentsHeading.y).toBe(tocGap);

		const closing = sampleMotion();
		await page.getByRole("button", { name: "Close panel" }).click();
		expectInStep(await closing);
		expect(await centredLine.boundingBox()).toEqual(restingBox);
	});

	test("a version preview shows its text where the editor's text sits, and Back to current returns to it", async ({
		owner,
	}) => {
		const { page } = owner;
		await page.setViewportSize({ width: 1440, height: 900 });
		await openWriterDocument(page, node);
		await typeParagraph(page, "First version");
		await expectSaved(page);
		await saveNamedVersion(owner.context.request, node, "One");
		await typeParagraph(page, "Second version");
		await expectSaved(page);
		await saveNamedVersion(owner.context.request, node, "Two");
		await page
			.getByRole("button", { name: /versions/i })
			.first()
			.click();
		const panel = page.getByRole("complementary", { name: "Versions" });
		await expect.poll(async () => (await panel.boundingBox())?.width).toBe(320);
		const editorText = page.getByLabel("Document editor");
		const previewText = page.locator('[aria-label="Version preview"] .ProseMirror');
		const linePlacement = async (text: typeof editorText) => {
			const line = text.locator("p", { hasText: "First version" });
			const { x, y, width } = (await line.boundingBox())!;
			const { y: top } = (await text.boundingBox())!;
			return { x, width, top, y };
		};
		const editorPlacement = await linePlacement(editorText);
		const readLook = (element: Element) => {
			const style = getComputedStyle(element);
			return [
				style.backgroundColor,
				style.borderBottomColor,
				element.getBoundingClientRect().height,
			];
		};
		const barLook = (bar: ReturnType<typeof page.locator>) => bar.evaluate(readLook);
		const themes = ["light", "dark"] as const;
		const toolbar = page
			.getByRole("button", { name: "Bold" })
			.locator("xpath=ancestor::div[contains(@class, 'border-b')][1]");
		const toolbarLooks = [];
		for (const theme of themes) {
			await page.evaluate(
				(theme) => document.documentElement.setAttribute("data-theme", theme),
				theme,
			);
			toolbarLooks.push(await barLook(toolbar));
		}

		await panel.getByRole("button", { name: /^One/ }).click();
		await expect(previewText).toContainText("First version");
		const bar = page.getByRole("status").filter({ hasText: "Viewing One" });
		for (const [i, theme] of themes.entries()) {
			await page.evaluate(
				(theme) => document.documentElement.setAttribute("data-theme", theme),
				theme,
			);
			expect(await barLook(bar)).toEqual(toolbarLooks[i]);
			const backToCurrent = bar.getByRole("button", { name: "Back to current" });
			const backToCurrentFill = await backToCurrent.evaluate(
				(button) => getComputedStyle(button).backgroundColor,
			);
			expect(backToCurrentFill).toBe("rgba(0, 0, 0, 0)");
		}
		// frappe-ui gives an empty read-only line a fixed height, so lines below one may sit a few px off.
		expect(await linePlacement(previewText)).toMatchObject({
			x: editorPlacement.x,
			width: editorPlacement.width,
			top: editorPlacement.top,
		});

		await panel.getByRole("button", { name: /^Two/ }).click();
		await expect(previewText).toContainText("Second version");
		expect(await linePlacement(previewText)).toMatchObject({
			x: editorPlacement.x,
			width: editorPlacement.width,
			top: editorPlacement.top,
		});

		await page.getByRole("button", { name: "Back to current" }).click();
		await expect(editorText).toBeVisible();
		expect(await linePlacement(editorText)).toEqual(editorPlacement);
	});
});
