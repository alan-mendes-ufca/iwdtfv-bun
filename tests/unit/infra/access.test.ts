import { afterEach, describe, expect, test } from "bun:test";
import { authenticate, validateSecurityConfig } from "infra/access";

const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("access.authenticate", () => {
  test("none mode ignores forged Tailscale identity headers", () => {
    process.env.APP_AUTH_MODE = "none";
    process.env.APP_ALLOWED_USERS = "owner@example.com";
    const request = new Request("http://localhost/", {
      headers: { "Tailscale-User-Login": "owner@example.com" },
    });
    expect(authenticate(request)).toBeNull();
  });

  test("tailscale mode requires an allowed login and returns its normalized value", () => {
    process.env.APP_AUTH_MODE = "tailscale";
    process.env.APP_ALLOWED_USERS = "Owner@example.com, teammate@example.com";
    expect(
      authenticate(
        new Request("http://localhost/", {
          headers: { "Tailscale-User-Login": " OWNER@example.com " },
        }),
      ),
    ).toBe("owner@example.com");
    expect(() => authenticate(new Request("http://localhost/"))).toThrow();
    expect(() =>
      authenticate(
        new Request("http://localhost/", {
          headers: { "Tailscale-User-Login": "intruder@example.com" },
        }),
      ),
    ).toThrow();
  });
});

describe("access.validateSecurityConfig", () => {
  function validTailscaleConfig() {
    process.env.APP_AUTH_MODE = "tailscale";
    process.env.APP_ALLOWED_USERS = "owner@example.com";
    process.env.APP_ORIGIN = "https://video.example.ts.net";
    process.env.ALLOWED_HOSTS = "video.example.ts.net";
  }

  test("requires an allowed user and HTTPS origin on the host allowlist", () => {
    validTailscaleConfig();
    delete process.env.APP_ALLOWED_USERS;
    expect(() => validateSecurityConfig()).toThrow(
      "Configure APP_ALLOWED_USERS.",
    );

    validTailscaleConfig();
    process.env.APP_ORIGIN = "http://video.example.ts.net";
    expect(() => validateSecurityConfig()).toThrow();

    validTailscaleConfig();
    process.env.ALLOWED_HOSTS = "other.example.ts.net";
    expect(() => validateSecurityConfig()).toThrow();
  });

  test("rejects cookie fallback unless Tailscale access and a file are configured", () => {
    process.env.YTDLP_COOKIES_MODE = "fallback";
    process.env.YTDLP_COOKIES_FILE = "/synthetic/cookies.txt";
    process.env.APP_AUTH_MODE = "none";
    expect(() => validateSecurityConfig()).toThrow();

    validTailscaleConfig();
    delete process.env.YTDLP_COOKIES_FILE;
    expect(() => validateSecurityConfig()).toThrow();

    validTailscaleConfig();
    process.env.YTDLP_COOKIES_FILE = "/synthetic/cookies.txt";
    expect(() => validateSecurityConfig()).not.toThrow();
  });

  test("fails closed for an unknown auth mode", () => {
    process.env.APP_AUTH_MODE = "maybe";
    expect(() => validateSecurityConfig()).toThrow("APP_AUTH_MODE inválido.");
  });
});
