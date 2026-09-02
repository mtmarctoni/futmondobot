import { describe, expect, it } from "vitest";
import { fetchFitness, parseFitnessPage } from "./futbolfantasy";

/**
 * Mirrors the real markup at futbolfantasy.com/laliga/lesionados as observed on
 * 2026-09-02: club headers preceding groups of `elemento` blocks, each with a
 * `jugador` link, a `probabilidad-widget` percentage and a `gravedad-N` class.
 */
const PAGE = `
<div class="lesionados_wrapper">
  <small>Actualizado el 02/09/2026</small>
  <div class="lesionados_subwrapper row">
    <section class="mod lesionados">
      <header class="title col-12"><img class="icono" src="x.png"> Alav&eacute;s</header>
      <div class="elemento lesionado col-12">
        <div class="fotocontainer laliga gravedad-0">
          <span class="probabilidad-widget"><span class="prob-0 prob-0">0%</span></span>
        </div>
        <a href="/jugadores/toni" class="jugador">Toni Martinez</a>
        <div class="comentario"><span class="les">Microrrotura en el s&oacute;leo</span> Desde 28/08</div>
      </div>
    </section>
    <section class="mod lesionados">
      <header class="title col-12"><img class="icono" src="y.png"> Barcelona</header>
      <div class="elemento lesionado col-12">
        <div class="fotocontainer laliga gravedad-1">
          <span class="probabilidad-widget"><span class="prob-0 prob-0">30%</span></span>
        </div>
        <a href="/jugadores/gavi" class="jugador">Pablo Gavi</a>
        <div class="comentario">Contusi&oacute;n en la rodilla</div>
      </div>
      <div class="elemento lesionado col-12">
        <div class="fotocontainer laliga gravedad-0">
          <span class="probabilidad-widget"><span class="prob-0 prob-0">100%</span></span>
        </div>
        <a href="/jugadores/dejong" class="jugador">Frenkie de Jong</a>
      </div>
    </section>
  </div>
</div>`;

describe("parseFitnessPage", () => {
  it("reads name, probability, severity and club for every row", () => {
    const result = parseFitnessPage(PAGE);

    expect(result.warnings).toEqual([]);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toMatchObject({
      name: "Toni Martinez",
      teamName: "Alavés",
      startProbability: 0,
      severity: 0,
    });
    expect(result.rows[1]).toMatchObject({
      name: "Pablo Gavi",
      teamName: "Barcelona",
      startProbability: 0.3,
      severity: 1,
    });
  });

  it("attributes each player to the club heading above them", () => {
    const result = parseFitnessPage(PAGE);
    expect(result.rows.map((r) => r.teamName)).toEqual([
      "Alavés",
      "Barcelona",
      "Barcelona",
    ]);
  });

  it("decodes entities in club names and notes", () => {
    const result = parseFitnessPage(PAGE);
    expect(result.rows[0].teamName).toBe("Alavés");
    expect(result.rows[0].note).toContain("sóleo");
  });

  it("reads the page's own update date", () => {
    expect(parseFitnessPage(PAGE).updatedOn).toBe("2026-09-02");
  });

  it("keeps probability inside 0..1", () => {
    const result = parseFitnessPage(PAGE);
    expect(result.rows[2].startProbability).toBe(1);
    for (const row of result.rows) {
      expect(row.startProbability).toBeGreaterThanOrEqual(0);
      expect(row.startProbability).toBeLessThanOrEqual(1);
    }
  });

  it("skips a row with no published percentage rather than inventing one", () => {
    const html = `
      <header class="title">Betis</header>
      <div class="elemento lesionado col-12">
        <a href="#" class="jugador">Sin Porcentaje</a>
      </div>`;
    expect(parseFitnessPage(html).rows).toEqual([]);
  });

  it("de-duplicates a player listed twice for the same club", () => {
    const duplicated = PAGE + PAGE;
    const result = parseFitnessPage(duplicated);
    const gavi = result.rows.filter((r) => r.name === "Pablo Gavi");
    expect(gavi).toHaveLength(1);
  });

  it("warns instead of throwing when the markup no longer matches", () => {
    const result = parseFitnessPage("<html><body>redesigned</body></html>");
    expect(result.rows).toEqual([]);
    expect(result.warnings[0]).toMatch(/markup has probably changed/);
  });
});

describe("fetchFitness", () => {
  it("degrades to an empty result on a non-200 response", async () => {
    const result = await fetchFitness({
      fetchImpl: (async () => new Response("nope", { status: 503 })) as typeof fetch,
    });
    expect(result.rows).toEqual([]);
    expect(result.warnings[0]).toMatch(/HTTP 503/);
  });

  it("degrades to an empty result when the host is unreachable", async () => {
    const result = await fetchFitness({
      fetchImpl: (async () => {
        throw new Error("ENOTFOUND");
      }) as typeof fetch,
    });
    expect(result.rows).toEqual([]);
    expect(result.warnings[0]).toMatch(/unreachable/);
  });

  it("sends a browser user-agent, since the default gets a different page", async () => {
    let seen: Record<string, string> = {};
    await fetchFitness({
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        seen = (init?.headers ?? {}) as Record<string, string>;
        return new Response(PAGE, { status: 200 });
      }) as typeof fetch,
    });
    expect(seen["User-Agent"]).toMatch(/Mozilla/);
  });

  it("parses a successful response", async () => {
    const result = await fetchFitness({
      fetchImpl: (async () => new Response(PAGE, { status: 200 })) as typeof fetch,
    });
    expect(result.rows).toHaveLength(3);
  });
});
