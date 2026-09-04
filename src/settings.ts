import { type App, PluginSettingTab, Setting } from "obsidian";

import type CodeDesignPlugin from "./main";

export interface CodeDesignSettings {
  port: number;
  outlineVisible: boolean;
}

export const DEFAULT_SETTINGS: CodeDesignSettings = {
  port: 27123,
  outlineVisible: true
};

export class CodeDesignSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: CodeDesignPlugin) {
    super(app, plugin);
  }

  display(): void {
    this.containerEl.empty();

    new Setting(this.containerEl)
      .setName("MCP server port")
      .setDesc("Restart Code Design after changing this port.")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.port))
          .setValue(String(this.plugin.settings.port))
          .onChange(async (value) => {
            const port = Number.parseInt(value, 10);
            if (Number.isInteger(port) && port >= 1024 && port <= 65535) {
              this.plugin.settings.port = port;
              await this.plugin.saveSettings();
            }
          })
      );
  }
}
