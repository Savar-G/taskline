import { Notice, PluginSettingTab, Setting } from "obsidian";
import type TasklinePlugin from "./main";
import { compileWorkspace, createSettingsDraft } from "./settings";

type CollectionKey = "sources" | "sourceGroups" | "areas" | "captureRoutes" | "tagFilters" | "displayOrder" | "ownerSelfAliases";

const SECTIONS: Array<{ key: CollectionKey; name: string; description: string }> = [
  { key: "sources", name: "Task sources", description: "JSON array of sources: id, label, path, role, optional groupId, editPolicy, and proposals." },
  { key: "sourceGroups", name: "Source groups", description: "JSON array of groups: id, label, mode, ownerDisplay, and optional color." },
  { key: "areas", name: "Areas", description: "JSON array of areas: id, label, sourceId, level-two heading, and optional color." },
  { key: "captureRoutes", name: "Capture routes", description: "Ordered JSON array of tag routes with aliases, a level-two heading destination, keywords, and showAsChip." },
  { key: "tagFilters", name: "Tag filters", description: "JSON array of generic tag filters: tag, label, and optional color." },
  { key: "displayOrder", name: "Display order", description: "JSON array of area and source-group IDs." },
  { key: "ownerSelfAliases", name: "Owner self aliases", description: "JSON array of owner names that should not render as owner chips." },
];

export class TasklineSettingTab extends PluginSettingTab {
  constructor(private readonly taskline: TasklinePlugin) {
    super(taskline.app, taskline);
  }

  display(): void {
    const { containerEl } = this;
    const draft = createSettingsDraft(this.taskline.settings, this.taskline.rejectedSettingsRaw);
    const parseErrors = new Map<string, string>();
    containerEl.empty();
    containerEl.createEl("p", {
      text: "Changes remain a draft until you apply them. Taskline never creates or changes task files from settings.",
    });

    this.renderIssues(
      [...this.taskline.settingsLoadIssues, ...this.taskline.workspace.issues],
      this.taskline.settingsLoadIssues.length > 0 ? "Saved configuration rejected" : "Active configuration"
    );
    const draftIssues = containerEl.createDiv({ cls: "vt-settings-issues" });
    draftIssues.hide();
    const renderDraftIssues = (): void => {
      const compiled = compileWorkspace(draft);
      const messages = [...parseErrors.values(), ...compiled.issues
        .filter((issue) => issue.level === "error")
        .map((issue) => `${issue.path} - ${issue.message}`)];
      draftIssues.empty();
      if (messages.length === 0) {
        draftIssues.hide();
        return;
      }
      draftIssues.show();
      draftIssues.setAttr("role", "alert");
      new Setting(draftIssues).setName("Draft validation").setHeading();
      const list = draftIssues.createEl("ul");
      for (const message of messages) list.createEl("li", { text: message });
    };

    new Setting(containerEl)
      .setName("Schema version")
      .setDesc("Taskline settings schema version.")
      .addText((text) => {
        text.setValue(String(draft.version));
        text.inputEl.setAttr("aria-label", "Schema version");
        text.onChange((value) => {
          const version = Number(value);
          if (!Number.isInteger(version)) {
            parseErrors.set("version", "Schema version: expected an integer");
          } else {
            draft.version = version;
            parseErrors.delete("version");
          }
          renderDraftIssues();
        });
      });

    for (const section of SECTIONS) {
      new Setting(containerEl)
        .setName(section.name)
        .setDesc(section.description)
        .addTextArea((text) => {
          text.inputEl.rows = 8;
          text.inputEl.addClass("vt-settings-json");
          text.inputEl.setAttr("aria-label", `${section.name} JSON`);
          text.setValue(JSON.stringify(draft[section.key], null, 2));
          text.onChange((value) => {
            try {
              const parsed = JSON.parse(value) as unknown;
              if (!Array.isArray(parsed)) throw new Error("Expected an array");
              draft[section.key] = parsed;
              parseErrors.delete(section.key);
            } catch (error) {
              parseErrors.set(section.key, `${section.name}: ${error instanceof Error ? error.message : "invalid JSON"}`);
            }
            renderDraftIssues();
          });
        });
    }

    new Setting(containerEl)
      .setName("Fallback capture destination")
      .setDesc("JSON object with source ID and a level-two heading, or null.")
      .addTextArea((text) => {
        text.inputEl.rows = 3;
        text.setValue(JSON.stringify(draft.fallbackCaptureDestination, null, 2));
        text.inputEl.setAttr("aria-label", "Fallback capture destination JSON");
        text.onChange((value) => {
          try {
            const parsed = JSON.parse(value) as unknown;
            if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
              throw new Error("Expected an object or null");
            }
            draft.fallbackCaptureDestination = parsed;
            parseErrors.delete("fallbackCaptureDestination");
          } catch (error) {
            parseErrors.set("fallbackCaptureDestination", `Fallback destination: ${error instanceof Error ? error.message : "invalid JSON"}`);
          }
          renderDraftIssues();
        });
      });

    new Setting(containerEl)
      .setName("Apply settings")
      .setDesc("Validate, initialize the candidate workspace, then save and activate it.")
      .addButton((button) => button.setButtonText("Apply").setCta().onClick(async () => {
        renderDraftIssues();
        const compiled = compileWorkspace(draft);
        if (parseErrors.size > 0 || compiled.issues.some((issue) => issue.level === "error")) {
          new Notice("Fix the draft validation errors before applying.");
          return;
        }
        button.setDisabled(true);
        try {
          await this.taskline.updateSettings(draft);
          new Notice("Taskline settings applied.");
          this.display();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Could not apply Taskline settings.");
          renderDraftIssues();
        } finally {
          button.setDisabled(false);
        }
      }));
  }

  private renderIssues(issues: Array<{ level: "error" | "warning"; path: string; message: string }>, title: string): void {
    if (issues.length === 0) return;
    const block = this.containerEl.createDiv({ cls: "vt-settings-issues" });
    block.setAttr("role", "status");
    new Setting(block).setName(title).setHeading();
    const list = block.createEl("ul");
    for (const issue of issues) {
      list.createEl("li", { text: `${issue.level === "error" ? "Error" : "Warning"}: ${issue.path} - ${issue.message}` });
    }
  }
}
