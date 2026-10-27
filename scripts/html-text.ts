import { load } from "cheerio";
import { normalizeText } from "../src/http";

/** HTML parsing is intentionally performed on the GitHub runner, not Worker. */
export function extractArticleText(html: string): string {
  const $ = load(html);
  $("script,style,noscript,svg,nav,header,footer,aside,form,button,iframe").remove();
  $("br").replaceWith("\n");
  $("p,div,li,h1,h2,h3,h4,h5,h6,pre,tr,section,blockquote").append("\n");
  let best = "";
  for (const selector of ["[itemprop='articleBody']", ".post-body", ".entry-content", "article", "main", "body"]) {
    const text = normalizeText($(selector).text());
    if (text.length > best.length) best = text;
    if (text.length >= 300 && selector !== "body") return text;
  }
  return best;
}
