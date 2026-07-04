import { splitByMarkers } from "@/lib/db/log-search";

/**
 * Render a sentinel-delimited log-search snippet (issue #409): the matched spans
 * come wrapped in the control-character markers `splitByMarkers` understands and
 * are shown as `<mark>`, the rest as muted context. Pure render from trusted
 * server text — no interactivity — so this stays a server component and adds no
 * client JS.
 */
export function LogMatchSnippet({ snippet, className }: { snippet: string; className?: string }) {
  let offset = 0;
  return (
    <span className={className}>
      {splitByMarkers(snippet).map((seg) => {
        const key = `${offset}:${seg.match ? "m" : "p"}`;
        offset += seg.text.length;
        return seg.match ? (
          <mark key={key} className="rounded-[3px] bg-warning-muted px-0.5 text-warning-foreground">
            {seg.text}
          </mark>
        ) : (
          <span key={key}>{seg.text}</span>
        );
      })}
    </span>
  );
}
