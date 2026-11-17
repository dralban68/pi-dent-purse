import assert from "node:assert/strict";
import { test } from "node:test";

import {
  configurationPath,
  loadConfiguration,
  parseConfiguration,
  type ConfigurationEnv,
  type LoadedConfiguration,
} from "../lib/config.ts";

const HOME = "/home/u";
const FILE = `${HOME}/.pi/purse/purse.conf`;

function parse(text: string | null, env: ConfigurationEnv = {}): LoadedConfiguration {
  return parseConfiguration(text, FILE, env);
}

/** Diagnostic messages without the file prefix: `"<key path>: <problem>"`. */
function problems(loaded: LoadedConfiguration): string[] {
  return loaded.diagnostics.map((diagnostic) => diagnostic.message.replace(`${FILE}: `, ""));
}

/** Asserts one diagnostic and returns its message without the file prefix. */
function only(loaded: LoadedConfiguration): string {
  assert.equal(
    loaded.diagnostics.length,
    1,
    `expected one diagnostic, got: ${problems(loaded).join(" | ")}`,
  );
  return problems(loaded)[0] ?? "";
}

function settings(text: string): LoadedConfiguration["providers"][string] {
  return parse(text).providers["zai"] ?? {};
}

test("a missing file is an empty configuration, silently", () => {
  assert.deepEqual(parse(null), {
    path: FILE,
    providers: {},
    severity: { low: 75, critical: 90 },
    statusLine: true,
    offline: false,
    diagnostics: [],
  });
});

test("the defaults are copied per load", () => {
  const first = parse(null);
  first.severity.low = 10;
  first.providers.zai = { free: true };
  const second = parse(null);
  assert.deepEqual(second.severity, { low: 75, critical: 90 });
  assert.deepEqual(second.providers, {});
});

test("an empty, blank, or comments-only file is an empty configuration, silently", () => {
  for (const text of ["", "  \n\t", "// nothing here\n", "/* a */ // b\n"]) {
    const loaded = parse(text);
    assert.deepEqual(loaded.diagnostics, [], JSON.stringify(text));
    assert.deepEqual(loaded.severity, { low: 75, critical: 90 });
    assert.deepEqual(loaded.providers, {});
    assert.equal(loaded.statusLine, true);
  }
});

test("a comment followed by a broken value is still a parse failure", () => {
  assert.match(only(parse("// x\n{ ")), /^invalid JSONC at offset \d+: /);
});

test("malformed JSONC produces one diagnostic and an empty configuration", () => {
  const loaded = parse('{ "statusLine": tru }');
  assert.match(only(loaded), /^invalid JSONC at offset \d+: (InvalidSymbol|ValueExpected)$/);
  assert.equal(loaded.statusLine, true);
  assert.deepEqual(loaded.providers, {});
});

test("a non-object root produces one diagnostic and an empty configuration", () => {
  for (const text of ["[]", "null", "42", '"text"', "true"]) {
    const loaded = parse(text);
    assert.equal(only(loaded), "expected the root to be an object", text);
    assert.deepEqual(loaded.providers, {}, text);
  }
});

test("every diagnostic names the file path", () => {
  const loaded = parse('{ "other": 1, "providers": { "zai": { "ttlSeconds": 1 } } }');
  assert.equal(loaded.diagnostics.length, 2);
  for (const diagnostic of loaded.diagnostics) {
    assert.equal(diagnostic.file, FILE);
    assert.ok(diagnostic.message.startsWith(`${FILE}: `), diagnostic.message);
  }
});

test("JSONC comments and trailing commas are accepted", () => {
  const loaded = parse(`{
    // one provider, free
    "providers": {
      "llm-dralban68": { "free": true }, /* trailing comma below */
      "deepseek": { "lowBalance": 5 },
      "zai": { "prices": { "glm-5.3-highspeed": { "input": 1.4, "output": 4.4 } } },
      "google": { "project": "my-project" },
    },
    "severity": { "low": 70, "critical": 90 },
  }`);
  assert.deepEqual(loaded.diagnostics, []);
  assert.deepEqual(loaded.providers, {
    "llm-dralban68": { free: true },
    deepseek: { lowBalance: 5 },
    zai: { prices: { "glm-5.3-highspeed": { input: 1.4, output: 4.4 } } },
    google: { project: "my-project" },
  });
  assert.deepEqual(loaded.severity, { low: 70, critical: 90 });
  assert.equal(loaded.statusLine, true);
});

test("an unknown root key produces one diagnostic and is ignored", () => {
  const loaded = parse('{ "statusLine": false, "extra": {} }');
  assert.deepEqual(problems(loaded), ["extra: unknown key"]);
  assert.equal(loaded.statusLine, false);
});

test("statusLine defaults to true and accepts a boolean", () => {
  assert.equal(parse("{}").statusLine, true);
  assert.equal(parse('{ "statusLine": true }').statusLine, true);
  assert.equal(parse('{ "statusLine": false }').statusLine, false);

  for (const value of ['"true"', "1", "null", "{}", "[]"]) {
    const loaded = parse(`{ "statusLine": ${value} }`);
    assert.deepEqual(problems(loaded), ["statusLine: expected a boolean"], value);
    assert.equal(loaded.statusLine, true, value);
  }
});

test("severity defaults to 75 and 90", () => {
  assert.deepEqual(parse("{}").severity, { low: 75, critical: 90 });
  assert.deepEqual(parse('{ "severity": {} }').severity, { low: 75, critical: 90 });
  assert.deepEqual(parse('{ "severity": { "low": 70 } }').severity, { low: 70, critical: 90 });
  assert.deepEqual(parse('{ "severity": { "critical": 95 } }').severity, { low: 75, critical: 95 });
});

test("severity accepts the boundary 0 < low < critical ≤ 100", () => {
  assert.deepEqual(parse('{ "severity": { "low": 1, "critical": 100 } }').severity, {
    low: 1,
    critical: 100,
  });
  assert.deepEqual(parse('{ "severity": { "low": 74.5, "critical": 75.25 } }').severity, {
    low: 74.5,
    critical: 75.25,
  });
});

test("severity order violations default both and produce one diagnostic", () => {
  for (const thresholds of [
    '{ "low": 0, "critical": 90 }',
    '{ "low": -1, "critical": 90 }',
    '{ "low": 90, "critical": 90 }',
    '{ "low": 91, "critical": 90 }',
    '{ "low": 70, "critical": 101 }',
  ]) {
    const loaded = parse(`{ "severity": ${thresholds} }`);
    assert.deepEqual(problems(loaded), ["severity: expected 0 < low < critical ≤ 100"], thresholds);
    assert.deepEqual(loaded.severity, { low: 75, critical: 90 }, thresholds);
  }
});

test("an invalid severity field defaults alone and siblings still load", () => {
  const low = parse('{ "severity": { "low": "70", "critical": 95 } }');
  assert.deepEqual(problems(low), ["severity.low: expected a number"]);
  assert.deepEqual(low.severity, { low: 75, critical: 95 });

  const critical = parse('{ "severity": { "low": 60, "critical": null } }');
  assert.deepEqual(problems(critical), ["severity.critical: expected a number"]);
  assert.deepEqual(critical.severity, { low: 60, critical: 90 });
});

test("a non-object severity produces one diagnostic and the defaults", () => {
  for (const value of ['"high"', "90", "null", "[]"]) {
    const loaded = parse(`{ "severity": ${value} }`);
    assert.deepEqual(problems(loaded), ["severity: expected an object"], value);
    assert.deepEqual(loaded.severity, { low: 75, critical: 90 }, value);
  }
});

test("an unknown severity key produces one diagnostic and is ignored", () => {
  const loaded = parse('{ "severity": { "low": 70, "high": 80 } }');
  assert.deepEqual(problems(loaded), ["severity.high: unknown key"]);
  assert.deepEqual(loaded.severity, { low: 70, critical: 90 });
});

test("providers defaults to an empty object", () => {
  assert.deepEqual(parse("{}").providers, {});
  assert.deepEqual(parse('{ "providers": {} }').providers, {});
});

test("a non-object providers value produces one diagnostic and the default", () => {
  for (const value of ['"zai"', "[]", "null", "3"]) {
    const loaded = parse(`{ "providers": ${value} }`);
    assert.deepEqual(problems(loaded), ["providers: expected an object"], value);
    assert.deepEqual(loaded.providers, {}, value);
  }
});

test("a provider entry that is not an object produces one diagnostic and is ignored", () => {
  const loaded = parse('{ "providers": { "zai": "free", "deepseek": { "lowBalance": 5 } } }');
  assert.deepEqual(problems(loaded), ["providers.zai: expected an object"]);
  assert.deepEqual(loaded.providers, { deepseek: { lowBalance: 5 } });
});

test("provider ids must match the provider-id pattern", () => {
  for (const id of ["", "-zai", "zai!", "a b", ".zai", "a".repeat(129)]) {
    const loaded = parse(`{ "providers": { ${JSON.stringify(id)}: { "free": true } } }`);
    assert.deepEqual(
      problems(loaded),
      [`providers.${id}: expected a provider id matching ^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$`],
      id,
    );
    assert.deepEqual(loaded.providers, {}, id);
  }

  for (const id of ["A", "llm-dralban68", "a.b_c~d-1", "a".repeat(128)]) {
    const loaded = parse(`{ "providers": { ${JSON.stringify(id)}: { "free": true } } }`);
    assert.deepEqual(loaded.diagnostics, [], id);
    assert.deepEqual(loaded.providers[id], { free: true }, id);
  }
});

test("an unknown provider key produces one diagnostic and is ignored", () => {
  const loaded = parse('{ "providers": { "zai": { "lowBalance": 5, "region": "eu" } } }');
  assert.deepEqual(problems(loaded), ["providers.zai.region: unknown key"]);
  assert.deepEqual(loaded.providers.zai, { lowBalance: 5 });
});

test("free declares a free provider", () => {
  const loaded = parse('{ "providers": { "llm-dralban68": { "free": true } } }');
  assert.deepEqual(loaded.diagnostics, []);
  assert.deepEqual(loaded.providers["llm-dralban68"], { free: true });
});

test("free false is kept and a non-boolean free is ignored", () => {
  assert.deepEqual(settings('{ "providers": { "zai": { "free": false } } }'), { free: false });

  const loaded = parse('{ "providers": { "zai": { "free": "yes", "lowBalance": 5 } } }');
  assert.deepEqual(problems(loaded), ["providers.zai.free: expected a boolean"]);
  assert.deepEqual(loaded.providers.zai, { lowBalance: 5 });
});

test("a free provider diagnoses each conflicting key once and keeps only free", () => {
  const loaded = parse(`{ "providers": { "google": {
    "free": true,
    "adapter": false,
    "ttlSeconds": 120,
    "lowBalance": 5,
    "prices": { "m": { "input": 1 } },
    "schedule": null,
    "project": "p"
  } } }`);
  assert.deepEqual(problems(loaded), [
    "providers.google.adapter: ignored on a free provider",
    "providers.google.ttlSeconds: ignored on a free provider",
    "providers.google.lowBalance: ignored on a free provider",
    "providers.google.prices: ignored on a free provider",
    "providers.google.schedule: ignored on a free provider",
    "providers.google.project: ignored on a free provider",
  ]);
  assert.deepEqual(loaded.providers.google, { free: true });
});

test("a free provider ignores invalid settings without further diagnostics", () => {
  const loaded = parse('{ "providers": { "zai": { "free": true, "ttlSeconds": "soon" } } }');
  assert.deepEqual(problems(loaded), ["providers.zai.ttlSeconds: ignored on a free provider"]);
  assert.deepEqual(loaded.providers.zai, { free: true });
});

test("adapter accepts a boolean", () => {
  assert.deepEqual(settings('{ "providers": { "zai": { "adapter": false } } }'), {
    adapter: false,
  });
  assert.deepEqual(settings('{ "providers": { "zai": { "adapter": true } } }'), { adapter: true });
});

test("an invalid adapter produces one diagnostic and is ignored", () => {
  for (const value of ['"no"', "0", "null", "[]"]) {
    const loaded = parse(`{ "providers": { "zai": { "adapter": ${value} } } }`);
    assert.deepEqual(problems(loaded), ["providers.zai.adapter: expected a boolean"], value);
    assert.deepEqual(loaded.providers.zai, {}, value);
  }
});

test("ttlSeconds accepts integers from 60 to 86400", () => {
  assert.deepEqual(settings('{ "providers": { "zai": { "ttlSeconds": 60 } } }'), {
    ttlSeconds: 60,
  });
  assert.deepEqual(settings('{ "providers": { "zai": { "ttlSeconds": 86400 } } }'), {
    ttlSeconds: 86400,
  });
  assert.deepEqual(settings('{ "providers": { "zai": { "ttlSeconds": 3600 } } }'), {
    ttlSeconds: 3600,
  });
});

test("an invalid ttlSeconds produces one diagnostic and its default applies", () => {
  for (const value of ["59", "86401", "60.5", "0", "-60", '"60"', "null", "[60]", "{}"]) {
    const loaded = parse(`{ "providers": { "zai": { "ttlSeconds": ${value}, "lowBalance": 5 } } }`);
    assert.deepEqual(
      problems(loaded),
      ["providers.zai.ttlSeconds: expected an integer from 60 to 86400"],
      value,
    );
    assert.deepEqual(loaded.providers.zai, { lowBalance: 5 }, value);
  }
});

test("lowBalance is a number of at least 0", () => {
  assert.deepEqual(settings('{ "providers": { "zai": { "lowBalance": 0 } } }'), { lowBalance: 0 });
  assert.deepEqual(settings('{ "providers": { "zai": { "lowBalance": 5 } } }'), { lowBalance: 5 });
  assert.deepEqual(settings('{ "providers": { "zai": { "lowBalance": 0.25 } } }'), {
    lowBalance: 0.25,
  });
});

test("an invalid lowBalance produces one diagnostic and its default applies", () => {
  for (const value of ["-1", "-0.01", '"5"', "null", "[]", "{}", "true"]) {
    const loaded = parse(
      `{ "providers": { "zai": { "lowBalance": ${value}, "ttlSeconds": 60 } } }`,
    );
    assert.deepEqual(
      problems(loaded),
      ["providers.zai.lowBalance: expected a number of at least 0"],
      value,
    );
    assert.deepEqual(loaded.providers.zai, { ttlSeconds: 60 }, value);
  }
});

test("prices hold per-model rate overrides", () => {
  const loaded = parse(
    '{ "providers": { "zai": { "prices": { "glm-5.3": { "input": 1.4, "output": 4.4 }, "m2": { "cacheRead": 0, "cacheWrite": null } } } } }',
  );
  assert.deepEqual(loaded.diagnostics, []);
  assert.deepEqual(loaded.providers.zai, {
    prices: {
      "glm-5.3": { input: 1.4, output: 4.4 },
      m2: { cacheRead: 0, cacheWrite: null },
    },
  });
});

test("an invalid rate produces one diagnostic and is omitted, siblings still apply", () => {
  const loaded = parse(
    '{ "providers": { "zai": { "prices": { "glm-5.3": { "input": 1.4, "output": -1, "cacheRead": "1" } } } } }',
  );
  assert.deepEqual(problems(loaded), [
    "providers.zai.prices.glm-5.3.output: expected a number ≥ 0 or null",
    "providers.zai.prices.glm-5.3.cacheRead: expected a number ≥ 0 or null",
  ]);
  assert.deepEqual(loaded.providers.zai, { prices: { "glm-5.3": { input: 1.4 } } });
});

test("an unknown rate key produces one diagnostic and is ignored", () => {
  const loaded = parse(
    '{ "providers": { "zai": { "prices": { "glm-5.3": { "input": 1, "cached": 2 } } } } }',
  );
  assert.deepEqual(problems(loaded), ["providers.zai.prices.glm-5.3.cached: unknown key"]);
  assert.deepEqual(loaded.providers.zai, { prices: { "glm-5.3": { input: 1 } } });
});

test("prices and their entries must be objects", () => {
  const notObject = parse('{ "providers": { "zai": { "prices": [] } } }');
  assert.deepEqual(problems(notObject), ["providers.zai.prices: expected an object"]);
  assert.deepEqual(notObject.providers.zai, {});

  const entry = parse(
    '{ "providers": { "zai": { "prices": { "glm-5.3": "cheap", "m2": { "input": 1 } } } } }',
  );
  assert.deepEqual(problems(entry), ["providers.zai.prices.glm-5.3: expected an object"]);
  assert.deepEqual(entry.providers.zai, { prices: { m2: { input: 1 } } });
});

test("schedule null disables the built-in schedule", () => {
  const loaded = parse('{ "providers": { "zai": { "schedule": null } } }');
  assert.deepEqual(loaded.diagnostics, []);
  assert.equal(loaded.providers.zai?.schedule, null);
});

test("a valid schedule loads without computed fields", () => {
  const loaded = parse(`{ "providers": { "zai": { "schedule": {
    "multiplier": 0.5,
    "timeZone": "Asia/Shanghai",
    "windows": [
      { "days": [1, 2, 3, 4, 5], "from": "00:00", "to": "08:00" },
      { "days": [0, 6], "from": "23:00", "to": "24:00" }
    ]
  } } } }`);
  assert.deepEqual(loaded.diagnostics, []);
  assert.deepEqual(loaded.providers.zai, {
    schedule: {
      multiplier: 0.5,
      timeZone: "Asia/Shanghai",
      windows: [
        { days: [1, 2, 3, 4, 5], from: "00:00", to: "08:00" },
        { days: [0, 6], from: "23:00", to: "24:00" },
      ],
    },
  });
});

test("an invalid schedule multiplier produces one diagnostic and drops the schedule", () => {
  for (const value of ["0", "-1", '"0.5"', "null", "true"]) {
    const loaded = parse(
      `{ "providers": { "zai": { "schedule": { "multiplier": ${value}, "timeZone": "UTC", "windows": [] } } } }`,
    );
    assert.deepEqual(
      problems(loaded),
      ["providers.zai.schedule.multiplier: expected a number greater than 0"],
      value,
    );
    assert.deepEqual(loaded.providers.zai, {}, value);
  }
});

test("schedule requires multiplier, timeZone, and windows", () => {
  const loaded = parse('{ "providers": { "zai": { "schedule": {} } } }');
  assert.deepEqual(problems(loaded), [
    "providers.zai.schedule.multiplier: expected a number greater than 0",
    "providers.zai.schedule.timeZone: expected an IANA time zone name",
    "providers.zai.schedule.windows: expected an array",
  ]);
  assert.deepEqual(loaded.providers.zai, {});
});

test("an invalid schedule timeZone produces one diagnostic and drops the schedule", () => {
  for (const value of ['"Not/AZone"', '""', "null", "1"]) {
    const loaded = parse(
      `{ "providers": { "zai": { "schedule": { "multiplier": 1, "timeZone": ${value}, "windows": [] } } } }`,
    );
    assert.deepEqual(
      problems(loaded),
      ["providers.zai.schedule.timeZone: expected an IANA time zone name"],
      value,
    );
    assert.deepEqual(loaded.providers.zai, {}, value);
  }
});

test("a schedule that is neither an object nor null produces one diagnostic", () => {
  for (const value of ['"off"', "0", "[]"]) {
    const loaded = parse(`{ "providers": { "zai": { "schedule": ${value} } } }`);
    assert.deepEqual(
      problems(loaded),
      ["providers.zai.schedule: expected an object or null"],
      value,
    );
    assert.deepEqual(loaded.providers.zai, {}, value);
  }
});

test("an unknown schedule key produces one diagnostic and is ignored", () => {
  const loaded = parse(`{ "providers": { "zai": { "schedule": {
    "multiplier": 1, "timeZone": "UTC", "windows": [], "holidays": []
  } } } }`);
  assert.deepEqual(problems(loaded), ["providers.zai.schedule.holidays: unknown key"]);
  assert.deepEqual(loaded.providers.zai, {
    schedule: { multiplier: 1, timeZone: "UTC", windows: [] },
  });
});

test("schedule window days are integers from 0 to 6", () => {
  const valid = parse(`{ "providers": { "zai": { "schedule": {
    "multiplier": 1, "timeZone": "UTC", "windows": [{ "days": [0, 6], "from": "00:00", "to": "01:00" }]
  } } } }`);
  assert.deepEqual(valid.diagnostics, []);

  for (const value of ["[-1]", "[7]", "[1.5]", '["1"]', "0", '"1"', "null", "[null]"]) {
    const loaded = parse(`{ "providers": { "zai": { "schedule": {
      "multiplier": 1, "timeZone": "UTC", "windows": [{ "days": ${value}, "from": "00:00", "to": "01:00" }]
    } } } }`);
    assert.deepEqual(
      problems(loaded),
      ["providers.zai.schedule.windows[0].days: expected an array of integers from 0 to 6"],
      value,
    );
    assert.deepEqual(loaded.providers.zai, {}, value);
  }
});

test("schedule window times are HH:MM with from earlier than to", () => {
  for (const value of ['"9:00"', '"24:00"', '"25:00"', '"00:60"', '"08:00:00"', "800", "null"]) {
    const loaded = parse(`{ "providers": { "zai": { "schedule": {
      "multiplier": 1, "timeZone": "UTC", "windows": [{ "days": [1], "from": ${value}, "to": "24:00" }]
    } } } }`);
    assert.deepEqual(
      problems(loaded),
      ["providers.zai.schedule.windows[0].from: expected a local time HH:MM"],
      value,
    );
    assert.deepEqual(loaded.providers.zai, {}, value);
  }

  for (const value of ['"24:01"', '"9:00"', "null", '"08:00 "']) {
    const loaded = parse(`{ "providers": { "zai": { "schedule": {
      "multiplier": 1, "timeZone": "UTC", "windows": [{ "days": [1], "from": "07:00", "to": ${value} }]
    } } } }`);
    assert.deepEqual(
      problems(loaded),
      ["providers.zai.schedule.windows[0].to: expected a local time HH:MM up to 24:00"],
      value,
    );
  }
});

test("a schedule window from at or after to produces one diagnostic", () => {
  for (const [from, to] of [
    ["09:00", "09:00"],
    ["10:00", "09:00"],
  ]) {
    const loaded = parse(`{ "providers": { "zai": { "schedule": {
      "multiplier": 1, "timeZone": "UTC", "windows": [{ "days": [1], "from": "${from}", "to": "${to}" }]
    } } } }`);
    assert.deepEqual(problems(loaded), [
      "providers.zai.schedule.windows[0].from: expected a time earlier than `to`",
    ]);
    assert.deepEqual(loaded.providers.zai, {});
  }
});

test("a schedule window must be an object and has no unknown keys", () => {
  const notObject = parse(`{ "providers": { "zai": { "schedule": {
    "multiplier": 1, "timeZone": "UTC", "windows": ["00:00-08:00"]
  } } } }`);
  assert.deepEqual(problems(notObject), ["providers.zai.schedule.windows[0]: expected an object"]);

  const unknown = parse(`{ "providers": { "zai": { "schedule": {
    "multiplier": 1, "timeZone": "UTC", "windows": [{ "days": [1], "from": "00:00", "to": "01:00", "label": "night" }]
  } } } }`);
  assert.deepEqual(problems(unknown), ["providers.zai.schedule.windows[0].label: unknown key"]);
  assert.deepEqual(unknown.providers.zai, {
    schedule: {
      multiplier: 1,
      timeZone: "UTC",
      windows: [{ days: [1], from: "00:00", to: "01:00" }],
    },
  });
});

test("project is a string on google only", () => {
  const google = parse('{ "providers": { "google": { "project": "my-project" } } }');
  assert.deepEqual(google.diagnostics, []);
  assert.deepEqual(google.providers.google, { project: "my-project" });

  const notString = parse('{ "providers": { "google": { "project": 42 } } }');
  assert.deepEqual(problems(notString), [
    "providers.google.project: expected a cloud project id or number",
  ]);
  assert.deepEqual(notString.providers.google, {});

  const number = parse('{ "providers": { "google": { "project": "123456789012" } } }');
  assert.deepEqual(number.diagnostics, []);
  assert.deepEqual(number.providers.google, { project: "123456789012" });

  for (const bad of ["", "My-Project", "proj/../x", "a?b", "abcde-", "abc", "1".repeat(21)]) {
    const loaded = parse(`{ "providers": { "google": { "project": ${JSON.stringify(bad)} } } }`);
    assert.deepEqual(problems(loaded), [
      "providers.google.project: expected a cloud project id or number",
    ]);
    assert.deepEqual(loaded.providers.google, {}, bad);
  }

  const other = parse('{ "providers": { "anthropic": { "project": "my-project" } } }');
  assert.deepEqual(problems(other), ["providers.anthropic.project: unknown key"]);
  assert.deepEqual(other.providers.anthropic, {});
});

test("a free provider on another provider treats project as an unknown key", () => {
  const loaded = parse('{ "providers": { "zai": { "free": true, "project": "p" } } }');
  assert.deepEqual(problems(loaded), ["providers.zai.project: unknown key"]);
  assert.deepEqual(loaded.providers.zai, { free: true });
});

test("providers load independently", () => {
  const loaded = parse(`{ "providers": {
    "zai": { "ttlSeconds": 30, "lowBalance": 5 },
    "deepseek": { "free": true },
    "anthropic": { "adapter": false }
  } }`);
  assert.deepEqual(problems(loaded), [
    "providers.zai.ttlSeconds: expected an integer from 60 to 86400",
  ]);
  assert.deepEqual(loaded.providers, {
    zai: { lowBalance: 5 },
    deepseek: { free: true },
    anthropic: { adapter: false },
  });
});

test("configurationPath uses the default path without PURSE_CONF", () => {
  assert.deepEqual(configurationPath({}, HOME), { path: FILE, diagnostics: [] });
  assert.deepEqual(configurationPath({ PURSE_CONF: undefined }, HOME), {
    path: FILE,
    diagnostics: [],
  });
});

test("configurationPath uses an absolute PURSE_CONF", () => {
  assert.deepEqual(configurationPath({ PURSE_CONF: "/etc/purse.conf" }, HOME), {
    path: "/etc/purse.conf",
    diagnostics: [],
  });
});

test("a relative PURSE_CONF produces one diagnostic and is ignored", () => {
  for (const value of ["purse.conf", "~/purse.conf", "./purse.conf", ""]) {
    const location = configurationPath({ PURSE_CONF: value }, HOME);
    assert.equal(location.path, FILE, value);
    assert.deepEqual(
      location.diagnostics,
      [
        {
          file: value,
          keyPath: "PURSE_CONF",
          message: `${value}: PURSE_CONF: expected an absolute path`,
        },
      ],
      value,
    );
  }
});

test("PURSE_OFFLINE is 1 or ignored", () => {
  assert.equal(parse(null, { PURSE_OFFLINE: "1" }).offline, true);
  for (const value of ["0", "true", "yes", " 1", "1 ", ""]) {
    assert.equal(parse(null, { PURSE_OFFLINE: value }).offline, false, value);
  }
  assert.deepEqual(parse(null, { PURSE_OFFLINE: "0" }).diagnostics, []);
});

test("loadConfiguration reads the default path through its reader", () => {
  const paths: string[] = [];
  const loaded = loadConfiguration({
    env: {},
    homeDir: HOME,
    readFile: (path) => {
      paths.push(path);
      return '{ "statusLine": false }';
    },
  });
  assert.deepEqual(paths, [FILE]);
  assert.equal(loaded.path, FILE);
  assert.equal(loaded.statusLine, false);
  assert.deepEqual(loaded.diagnostics, []);
});

test("loadConfiguration uses an absolute PURSE_CONF", () => {
  const paths: string[] = [];
  const loaded = loadConfiguration({
    env: { PURSE_CONF: "/etc/purse.conf", PURSE_OFFLINE: "1" },
    homeDir: HOME,
    readFile: (path) => {
      paths.push(path);
      return "{}";
    },
  });
  assert.deepEqual(paths, ["/etc/purse.conf"]);
  assert.equal(loaded.path, "/etc/purse.conf");
  assert.equal(loaded.offline, true);
  assert.deepEqual(loaded.diagnostics, []);
});

test("loadConfiguration is silent when the file is missing", () => {
  const loaded = loadConfiguration({ env: {}, homeDir: HOME, readFile: () => null });
  assert.deepEqual(loaded.diagnostics, []);
  assert.deepEqual(loaded.providers, {});
  assert.equal(loaded.statusLine, true);

  const relative = loadConfiguration({
    env: { PURSE_CONF: "purse.conf" },
    homeDir: HOME,
    readFile: () => null,
  });
  assert.deepEqual(relative.diagnostics, [
    {
      file: "purse.conf",
      keyPath: "PURSE_CONF",
      message: "purse.conf: PURSE_CONF: expected an absolute path",
    },
  ]);
  assert.equal(relative.path, FILE);
});

test("a read failure produces one diagnostic and an empty configuration", () => {
  const loaded = loadConfiguration({
    env: {},
    homeDir: HOME,
    readFile: () => {
      throw new Error("EACCES: permission denied");
    },
  });
  assert.deepEqual(problems(loaded), ["could not be read: EACCES: permission denied"]);
  assert.deepEqual(loaded.providers, {});
  assert.deepEqual(loaded.severity, { low: 75, critical: 90 });
  assert.equal(loaded.statusLine, true);
});

test("a PURSE_CONF diagnostic precedes the file's diagnostics", () => {
  const loaded = loadConfiguration({
    env: { PURSE_CONF: "purse.conf" },
    homeDir: HOME,
    readFile: () => '{ "extra": 1 }',
  });
  assert.deepEqual(
    loaded.diagnostics.map((diagnostic) => diagnostic.keyPath),
    ["PURSE_CONF", "extra"],
  );
});
