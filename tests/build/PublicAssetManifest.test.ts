import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildPublicAssetManifest,
  clearPublicAssetManifestCache,
  copyRootPublicFiles,
  createHashedPublicAssetFiles,
  rewriteAssetsForCdn,
  shouldKeepRootPublicFile,
} from "../../src/build/PublicAssetManifest";
import { normalizeAssetPath } from "../../src/shared/util/AssetPath";

describe("PublicAssetManifest", () => {
  let tempDir: string | null = null;

  type TempResources = {
    resourcesDir: string;
    outDir: string;
  };

  async function createTempResources(): Promise<TempResources> {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "public-assets-"));
    const resourcesDir = path.join(tempDir, "resources");
    const outDir = path.join(tempDir, "static");
    await fs.mkdir(resourcesDir, { recursive: true });
    await fs.writeFile(path.join(resourcesDir, "manifest.json"), "{}\n");
    return { resourcesDir, outDir };
  }

  function getExpectedRelativeEmittedPath(
    fromAssetHref: string,
    targetAssetHref: string,
  ): string {
    const fromDir = path.posix.dirname(normalizeAssetPath(fromAssetHref));
    const targetPath = normalizeAssetPath(targetAssetHref);
    return path.posix.relative(fromDir, targetPath);
  }

  async function writeBitmapFontFixture(
    resourcesDir: string,
    xmlRelativePath: string,
    pageFilePath: string,
    pageContent: string = "png-v1",
  ): Promise<void> {
    const xmlPath = path.join(resourcesDir, xmlRelativePath);
    const pagePath = path.join(path.dirname(xmlPath), pageFilePath);
    const xmlPageFilePath = pageFilePath.split(path.sep).join(path.posix.sep);

    await fs.mkdir(path.dirname(pagePath), { recursive: true });
    await fs.writeFile(
      xmlPath,
      [
        '<?xml version="1.0"?>',
        "<font>",
        `  <pages><page id="0" file="${xmlPageFilePath}"/></pages>`,
        "</font>",
        "",
      ].join("\n"),
    );
    await fs.writeFile(pagePath, pageContent);
  }

  async function emitHashedAsset(
    outDir: string,
    assetHref: string,
  ): Promise<string> {
    return fs.readFile(
      path.join(outDir, normalizeAssetPath(assetHref)),
      "utf8",
    );
  }

  async function writeWebManifestFixture(
    resourcesDir: string,
    icons: Array<{ src?: string }>,
  ): Promise<void> {
    await fs.writeFile(
      path.join(resourcesDir, "manifest.json"),
      JSON.stringify(
        {
          name: "OpenFront",
          icons,
        },
        null,
        2,
      ),
    );
  }

  afterEach(async () => {
    clearPublicAssetManifestCache();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test("hashes manifest.json from its rewritten content", async () => {
    const { resourcesDir, outDir } = await createTempResources();

    await fs.mkdir(path.join(resourcesDir, "icons"), { recursive: true });
    await writeWebManifestFixture(resourcesDir, [
      { src: "icons/app-icon.png" },
    ]);
    await fs.writeFile(
      path.join(resourcesDir, "icons", "app-icon.png"),
      "icon-v1",
      "utf8",
    );

    const firstManifest = buildPublicAssetManifest([resourcesDir]);
    const firstManifestHref = firstManifest["manifest.json"];
    const firstIconHref = firstManifest["icons/app-icon.png"];

    createHashedPublicAssetFiles([resourcesDir], outDir, firstManifest);
    const firstOutput = await fs.readFile(
      path.join(outDir, firstManifestHref.slice(1)),
      "utf8",
    );

    await fs.writeFile(
      path.join(resourcesDir, "icons", "app-icon.png"),
      "icon-v2",
      "utf8",
    );
    clearPublicAssetManifestCache();

    const secondManifest = buildPublicAssetManifest([resourcesDir]);
    const secondManifestHref = secondManifest["manifest.json"];
    const secondIconHref = secondManifest["icons/app-icon.png"];

    expect(firstIconHref).not.toBe(secondIconHref);
    expect(firstManifestHref).not.toBe(secondManifestHref);
    expect(firstOutput).toContain(firstIconHref);
    expect(firstOutput).not.toContain(secondIconHref);
  });

  test("rewrites root-relative web manifest icon paths to hashed URLs", async () => {
    const { resourcesDir, outDir } = await createTempResources();

    await fs.mkdir(path.join(resourcesDir, "icons"), { recursive: true });
    await writeWebManifestFixture(resourcesDir, [
      { src: "/icons/app-icon.png" },
    ]);
    await fs.writeFile(
      path.join(resourcesDir, "icons", "app-icon.png"),
      "icon-v1",
      "utf8",
    );

    const assetManifest = buildPublicAssetManifest([resourcesDir]);
    createHashedPublicAssetFiles([resourcesDir], outDir, assetManifest);

    const emittedManifest = await emitHashedAsset(
      outDir,
      assetManifest["manifest.json"],
    );

    expect(emittedManifest).toContain(assetManifest["icons/app-icon.png"]);
    expect(emittedManifest).not.toContain('"/icons/app-icon.png"');
  });

  test("fails when web manifest references a missing local icon", async () => {
    const { resourcesDir } = await createTempResources();

    await writeWebManifestFixture(resourcesDir, [{ src: "icons/missing.png" }]);

    expect(() => buildPublicAssetManifest([resourcesDir])).toThrow(
      /manifest\.json references icons\/missing\.png/i,
    );
  });

  test("leaves external and data web manifest icon refs unchanged", async () => {
    const { resourcesDir, outDir } = await createTempResources();

    await writeWebManifestFixture(resourcesDir, [
      { src: "https://cdn.example.com/app-icon.png" },
      { src: "data:image/png;base64,AAA" },
    ]);

    const assetManifest = buildPublicAssetManifest([resourcesDir]);
    createHashedPublicAssetFiles([resourcesDir], outDir, assetManifest);

    const emittedManifest = await emitHashedAsset(
      outDir,
      assetManifest["manifest.json"],
    );

    expect(emittedManifest).toContain("https://cdn.example.com/app-icon.png");
    expect(emittedManifest).toContain("data:image/png;base64,AAA");
  });

  test("rewrites BMFont XML page filenames to hashed relative paths", async () => {
    const { resourcesDir, outDir } = await createTempResources();

    await writeBitmapFontFixture(
      resourcesDir,
      path.join("fonts", "test.xml"),
      "test.png",
    );

    const assetManifest = buildPublicAssetManifest([resourcesDir]);
    createHashedPublicAssetFiles([resourcesDir], outDir, assetManifest);

    const xmlHref = assetManifest["fonts/test.xml"];
    const pngHref = assetManifest["fonts/test.png"];
    const emittedXml = await emitHashedAsset(outDir, xmlHref);

    expect(emittedXml).toContain(
      getExpectedRelativeEmittedPath(xmlHref, pngHref),
    );
    expect(emittedXml).not.toContain('file="test.png"');
  });

  test("BMFont XML hash changes when a referenced page image changes", async () => {
    const { resourcesDir } = await createTempResources();

    await writeBitmapFontFixture(
      resourcesDir,
      path.join("fonts", "test.xml"),
      "test.png",
    );

    const firstManifest = buildPublicAssetManifest([resourcesDir]);

    await fs.writeFile(path.join(resourcesDir, "fonts", "test.png"), "png-v2");
    clearPublicAssetManifestCache();

    const secondManifest = buildPublicAssetManifest([resourcesDir]);

    expect(firstManifest["fonts/test.png"]).not.toBe(
      secondManifest["fonts/test.png"],
    );
    expect(firstManifest["fonts/test.xml"]).not.toBe(
      secondManifest["fonts/test.xml"],
    );
  });

  test("fails when BMFont XML references a missing page image", async () => {
    const { resourcesDir } = await createTempResources();

    await fs.mkdir(path.join(resourcesDir, "fonts"), { recursive: true });
    await fs.writeFile(
      path.join(resourcesDir, "fonts", "broken.xml"),
      [
        '<?xml version="1.0"?>',
        "<font>",
        '  <pages><page id="0" file="missing.png"/></pages>',
        "</font>",
        "",
      ].join("\n"),
    );

    expect(() => buildPublicAssetManifest([resourcesDir])).toThrow(
      /missing from the asset manifest/i,
    );
  });

  test("rewrites nested BMFont page references to the correct relative hashed path", async () => {
    const { resourcesDir, outDir } = await createTempResources();

    await writeBitmapFontFixture(
      resourcesDir,
      path.join("fonts", "nested", "atlas.xml"),
      path.join("pages", "p0.png"),
      "nested-png",
    );

    const assetManifest = buildPublicAssetManifest([resourcesDir]);
    createHashedPublicAssetFiles([resourcesDir], outDir, assetManifest);

    const xmlHref = assetManifest["fonts/nested/atlas.xml"];
    const pngHref = assetManifest["fonts/nested/pages/p0.png"];
    const emittedXml = await emitHashedAsset(outDir, xmlHref);

    expect(emittedXml).toContain(
      getExpectedRelativeEmittedPath(xmlHref, pngHref),
    );
    expect(emittedXml).not.toContain('file="pages/p0.png"');
  });

  test("copies unhashed public directories verbatim, keeping paths stable", async () => {
    const { resourcesDir, outDir } = await createTempResources();
    await fs.mkdir(path.join(resourcesDir, "press", "images"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(resourcesDir, "press", "index.html"),
      "<!doctype html>\n",
    );
    await fs.writeFile(
      path.join(resourcesDir, "press", "images", "key-art.png"),
      "png",
    );

    copyRootPublicFiles(resourcesDir, outDir);

    await expect(
      fs.readFile(path.join(outDir, "press", "index.html"), "utf8"),
    ).resolves.toBe("<!doctype html>\n");
    await expect(
      fs.readFile(path.join(outDir, "press", "images", "key-art.png"), "utf8"),
    ).resolves.toBe("png");
  });

  test("leaves directories outside the allowlist alone", () => {
    expect(shouldKeepRootPublicFile("press/index.html")).toBe(true);
    expect(shouldKeepRootPublicFile("terms-of-service.html")).toBe(true);
    expect(shouldKeepRootPublicFile("pressed/index.html")).toBe(false);
    expect(shouldKeepRootPublicFile("maps/world.bin")).toBe(false);
  });
});

describe("rewriteAssetsForCdn", () => {
  test("rewrites src=/assets/ to EJS placeholder", () => {
    const out = rewriteAssetsForCdn(
      `<script type="module" crossorigin src="/assets/index-XXX.js"></script>`,
    );
    expect(out).toBe(
      `<script type="module" crossorigin src="<%- locals.cdnBaseRaw || "" %>/assets/index-XXX.js"></script>`,
    );
  });

  test("rewrites href=/assets/ for modulepreload and stylesheet links", () => {
    const out = rewriteAssetsForCdn(
      `<link rel="modulepreload" href="/assets/vendor-XXX.js">\n<link rel="stylesheet" href="/assets/index-XXX.css">`,
    );
    expect(out).toBe(
      `<link rel="modulepreload" href="<%- locals.cdnBaseRaw || "" %>/assets/vendor-XXX.js">\n<link rel="stylesheet" href="<%- locals.cdnBaseRaw || "" %>/assets/index-XXX.css">`,
    );
  });

  test("supports single-quoted attribute values", () => {
    expect(rewriteAssetsForCdn(`<script src='/assets/x.js'></script>`)).toBe(
      `<script src='<%- locals.cdnBaseRaw || "" %>/assets/x.js'></script>`,
    );
  });

  test("does not rewrite /_assets/ (underscore manifest paths)", () => {
    const html = `<link rel="icon" href="/_assets/images/Favicon.hash.svg">`;
    expect(rewriteAssetsForCdn(html)).toBe(html);
  });

  test("does not rewrite already-absolute asset URLs", () => {
    const html = `<script src="https://example.com/assets/foo.js"></script>`;
    expect(rewriteAssetsForCdn(html)).toBe(html);
  });

  // Inline scripts containing the literal "/assets/..." string must survive
  // unrewrite — the regex requires whitespace before src=/href=, and inside a
  // JS string literal there's no preceding `src=`/`href=` token at all.
  test("does not mangle /assets/ inside inline script string literals", () => {
    const html = `<script>const url = "/assets/foo";</script>`;
    expect(rewriteAssetsForCdn(html)).toBe(html);
  });

  test("does not match data-src or other custom attributes", () => {
    const html = `<img data-src="/assets/foo.png">`;
    expect(rewriteAssetsForCdn(html)).toBe(html);
  });
});
