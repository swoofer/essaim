import { describe, it, expect } from "vitest";
import { parseSetParams, buildParamTypeMap, parseSetFileParams } from "../../cli/params.js";

describe("parseSetParams — coercition par type déclaré (#28)", () => {
  it("garde la string quand le catalogue déclare string mais la valeur ressemble à un nombre", () => {
    const typeMap = { "audit-specialist.focus_name": "string" as const };
    const p = parseSetParams(["audit-specialist.focus_name=7"], typeMap);
    expect(p["audit-specialist"]!.focus_name).toBe("7");
  });
  it("parse toujours les nombres pour les params numériques", () => {
    const typeMap = { "announce-before-write.announce_threshold": "number" as const };
    const p = parseSetParams(["announce-before-write.announce_threshold=2"], typeMap);
    expect(p["announce-before-write"]!.announce_threshold).toBe(2);
  });
  it("comportement inchangé sans typeMap (rétrocompat)", () => {
    const p = parseSetParams(["x.y=7"]);
    expect(p.x!.y).toBe(7);
  });
  it("buildParamTypeMap lit les types du catalogue réel", () => {
    const m = buildParamTypeMap();
    expect(m["audit-specialist.focus_name"]).toBe("string");
    expect(m["sequential-wait.retry_attempts"]).toBe("number");
    expect(m["user-brief.constraints"]).toBe("string[]");
  });
});

describe("parseSetFileParams — valeurs lues verbatim depuis un fichier (#35)", () => {
  it("lit le contenu du fichier verbatim (accents, apostrophes, guillemets, $ préservés)", () => {
    const content = "Contexte client : l'équipe a dit \"go\" pour $50k, café à préparer.";
    const p = parseSetFileParams(["user-brief.brief=tmp/brief.txt"], (path) => {
      expect(path).toBe("tmp/brief.txt");
      return content;
    });
    expect(p["user-brief"]!.brief).toBe(content);
  });

  it("préserve les sauts de ligne", () => {
    const content = "ligne 1\nligne 2\nligne 3";
    const p = parseSetFileParams(["b.p=file.txt"], () => content);
    expect(p.b!.p).toBe(content);
  });

  it("n'applique jamais JSON.parse — une valeur numérique reste une string", () => {
    const p = parseSetFileParams(["audit-specialist.focus_name=file.txt"], () => "7");
    expect(p["audit-specialist"]!.focus_name).toBe("7");
  });

  it("ignore les entrées sans '=' ", () => {
    const p = parseSetFileParams(["no-equals-sign"], () => "should-not-be-called");
    expect(p).toEqual({});
  });

  it("ignore les entrées sans '.' dans le chemin behavior.param", () => {
    const p = parseSetFileParams(["nodot=file.txt"], () => "content");
    expect(p).toEqual({});
  });

  it("fusionne plusieurs entrées, y compris sur le même behavior", () => {
    const p = parseSetFileParams(
      ["a.x=fx.txt", "a.y=fy.txt", "b.z=fz.txt"],
      (path) => `content-of-${path}`,
    );
    expect(p.a).toEqual({ x: "content-of-fx.txt", y: "content-of-fy.txt" });
    expect(p.b).toEqual({ z: "content-of-fz.txt" });
  });
});

describe("précédence de fusion --set-file OVER --set (mirror de cli/run.ts + cli/solo.ts)", () => {
  it("--set-file gagne en cas de conflit sur la même clé behavior.param", () => {
    const setParams = parseSetParams(["user-brief.brief=shell-value"]);
    const setFileParams = parseSetFileParams(
      ["user-brief.brief=brief.txt"],
      () => "file-content-with-'-and-$-and-\"",
    );
    // Même logique de fusion que cli/run.ts et cli/solo.ts : set-file écrase set.
    for (const [behavior, values] of Object.entries(setFileParams)) {
      setParams[behavior] = { ...setParams[behavior], ...values };
    }
    expect(setParams["user-brief"]!.brief).toBe(
      "file-content-with-'-and-$-and-\"",
    );
  });

  it("les clés non conflictuelles des deux sources sont conservées", () => {
    const setParams = parseSetParams(["user-brief.constraints=[\"a\"]"]);
    const setFileParams = parseSetFileParams(
      ["user-brief.brief=brief.txt"],
      () => "brief text",
    );
    for (const [behavior, values] of Object.entries(setFileParams)) {
      setParams[behavior] = { ...setParams[behavior], ...values };
    }
    expect(setParams["user-brief"]).toEqual({
      constraints: ["a"],
      brief: "brief text",
    });
  });
});
