import { describe, expect, it } from "vitest";

import { LEARN_ARTICLES, articleForConcept, findArticle } from "./articles";

describe("learn articles", () => {
  it("has unique slugs", () => {
    const slugs = LEARN_ARTICLES.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("uses url-safe slugs", () => {
    for (const article of LEARN_ARTICLES) {
      expect(article.slug, article.title).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("gives every article a summary and real body", () => {
    for (const article of LEARN_ARTICLES) {
      expect(article.summary.length, article.slug).toBeGreaterThan(20);
      expect(article.bodyMarkdown.length, article.slug).toBeGreaterThan(200);
      expect(article.conceptTags.length, article.slug).toBeGreaterThan(0);
    }
  });

  it("prefers the article whose slug is the tag", () => {
    // "market-structure" also carries the tag "trend"; without slug preference
    // the trend link resolves by array order, which is silently wrong.
    expect(articleForConcept("trend")?.slug).toBe("trend");
    expect(articleForConcept("support")?.slug).toBe("support");
  });

  it("resolves concept tags used by the analysis panels", () => {
    // Every tag the UI links on must have an article, or the link disappears.
    const linked = [
      "trend",
      "support",
      "resistance",
      "volume",
      "rsi",
      "ema",
      "stop-loss",
      "risk-reward",
      "setup-score",
      "status",
      "multi-timeframe",
    ];

    for (const concept of linked) {
      expect(articleForConcept(concept), concept).toBeDefined();
    }
  });

  it("keeps internal links pointing at articles that exist", () => {
    const slugs = new Set(LEARN_ARTICLES.map((a) => a.slug));

    for (const article of LEARN_ARTICLES) {
      const links = [...article.bodyMarkdown.matchAll(/\]\((\/learn\/[a-z0-9-]+)\)/g)];
      for (const [, href] of links) {
        expect(slugs.has(href.replace("/learn/", "")), `${article.slug} -> ${href}`).toBe(true);
      }
    }
  });

  it("never tells the reader that a trade will work", () => {
    // The learn content is where over-confident phrasing would creep in first.
    // "is not a guarantee" is the wording we want, so only an unnegated claim
    // counts as a failure.
    const negated = /\b(no|not|never|nothing|isn't|does not|cannot)\b[^.]{0,40}$/i;

    for (const article of LEARN_ARTICLES) {
      for (const match of article.bodyMarkdown.matchAll(/\bguarantee[sd]?\b/gi)) {
        const before = article.bodyMarkdown.slice(0, match.index);
        expect(negated.test(before), `${article.slug}: unnegated "guarantee"`).toBe(true);
      }

      expect(article.bodyMarkdown, article.slug).not.toMatch(/\bwill definitely\b/i);
      expect(article.bodyMarkdown, article.slug).not.toMatch(/\brisk[- ]free\b/i);
      expect(article.bodyMarkdown, article.slug).not.toMatch(/\bcan't lose\b/i);
      expect(article.bodyMarkdown, article.slug).not.toMatch(/\bsure thing\b/i);
    }
  });

  it("looks articles up by slug", () => {
    expect(findArticle("support")?.title).toMatch(/support/i);
    expect(findArticle("nope")).toBeUndefined();
  });
});
