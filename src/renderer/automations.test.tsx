import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { DesktopApi } from "../bridge/index.js";
import { AutomationsPage } from "./automations.js";
import { defaultTextStyles } from "./typography.js";

vi.mock("./data-table.js", () => ({
  DataTable: ({ tableId }: { tableId: string }) =>
    createElement("div", { "data-test-table": tableId }),
}));

it("keeps service maintenance and schedule actions out of the default uncluttered view", () => {
  const markup = renderToStaticMarkup(
    <AutomationsPage
      api={{} as DesktopApi}
      active={false}
      agents={[]}
      lines={{ horizontal: false, vertical: false, heading: false }}
      density="high"
      fit
      textStyles={defaultTextStyles}
    />,
  );

  expect(markup).toContain('<h1 class="table-title">Automations</h1>');
  expect(markup).toContain("Runs continue after you quit Code60.");
  expect(markup).toContain("<summary>Service options</summary>");
  expect(markup).toContain('data-test-table="automations"');
  expect(markup).toContain('data-test-table="automation-history"');
  expect(markup).not.toContain("Cancel active run");
  expect(markup).not.toContain("Delete automation");
  expect(markup).not.toContain("Read transcript");
  expect(markup).not.toContain("Read changes");
});
