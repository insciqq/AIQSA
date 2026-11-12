import { describe, expect, it } from "vitest";
import { createDiscordControlService, type DiscordControlServiceDeps } from "./control/service";
import { defaultDiscordControlService } from "./defaultDiscord";

describe("Discord defaults", () => {
  it("forwards every method of the control service to the routes, so a new command never answers 500", () => {
    // Building the service touches none of its dependencies; only its method names are compared.
    const built = createDiscordControlService({} as DiscordControlServiceDeps);
    expect(Object.keys(defaultDiscordControlService).sort()).toEqual(Object.keys(built).sort());
    for (const [name, method] of Object.entries(defaultDiscordControlService)) expect(typeof method, name).toBe("function");
  });
});
