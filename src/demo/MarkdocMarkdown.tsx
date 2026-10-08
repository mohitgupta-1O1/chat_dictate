import Markdoc, { type Config } from "@markdoc/markdoc";
import React from "react";

export const markdocConfig: Config = {
  tags: {
    citation: {
      render: "Citation",
      selfClosing: true,
      attributes: { id: { type: Number, required: true } },
    },
  },
};

function Citation({ id }: { id: number }) {
  return (
    <sup data-citation={id} className="citation">
      [{id}]
    </sup>
  );
}

export const markdocComponents = { Citation };

export function MarkdocMarkdown({ content }: { content: string }) {
  const tree = Markdoc.transform(Markdoc.parse(content), markdocConfig);
  return <>{Markdoc.renderers.react(tree, React, { components: markdocComponents })}</>;
}
