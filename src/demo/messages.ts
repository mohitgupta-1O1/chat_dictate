export type Renderer = "react-markdown" | "markdoc";

export interface DemoMessage {
  id: string;
  renderer: Renderer;
  content: string;
}

export const DEMO_MESSAGES: DemoMessage[] = [
  {
    id: "agent",
    renderer: "react-markdown",
    content: [
      "## How compound interest works",
      "",
      "Compound interest means you earn **interest on your interest**. Each period, the interest is added to the balance, so the next period's interest is a little larger.",
      "",
      "The formula is $A = P(1 + r/n)^{nt}$, where:",
      "",
      "- *P* is the starting amount",
      "- *r* is the yearly rate",
      "- *n* is how many times per year interest is added",
      "",
      "| Years | Balance at 5% |",
      "|---|---|",
      "| 1 | \\$1,050 |",
      "| 10 | \\$1,629 |",
      "",
      "You can check this with a few lines of code:",
      "",
      "```python",
      "balance = 1000 * (1 + 0.05) ** 10",
      "```",
      "",
      "Starting early matters more than starting big.",
    ].join("\n"),
  },
  {
    id: "markdoc",
    renderer: "markdoc",
    content: [
      "# Summary of the report",
      "",
      "Revenue grew by 12% compared with last year {% citation id=1 /%}, mainly from the new subscription plan.",
      "",
      "Costs stayed flat {% citation id=2 /%}. The team expects similar results next quarter.",
    ].join("\n"),
  },
];

export const STREAMING_MESSAGE: DemoMessage = {
  id: "long",
  renderer: "react-markdown",
  content: [
    "## A longer answer to test auto-scroll",
    "",
    ...Array.from(
      { length: 8 },
      (_, i) =>
        `Paragraph ${i + 1}. Reading long answers on screen can be tiring, so listening while the current word is highlighted helps you keep your place. You can pause at any time, change the speed, or click any word to jump straight to it.\n`,
    ),
  ].join("\n"),
};
