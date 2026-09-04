import type { Extension } from "@codemirror/state";
import {
  MarkdownRenderer,
  MarkdownView,
  Notice,
  Plugin,
  TFile
} from "obsidian";

import type { Proposal, Selection } from "./contracts";
import { createProposalEditorExtension } from "./editor-extension";
import { ProposalStore } from "./proposal-store";
import { ReviewController, type DocumentStore } from "./review-controller";
import { CodeDesignServer } from "./server";
import {
  CodeDesignSettingTab,
  DEFAULT_SETTINGS,
  type CodeDesignSettings
} from "./settings";

export default class CodeDesignPlugin extends Plugin {
  settings: CodeDesignSettings = DEFAULT_SETTINGS;
  private readonly proposals = new ProposalStore();
  private server: CodeDesignServer | undefined;
  private navigatedProposalId: string | undefined;
  private navigator: HTMLElement | undefined;
  private outline: HTMLElement | undefined;
  private outlineAction: HTMLElement | undefined;
  private outlineActionView: MarkdownView | undefined;

  async onload(): Promise<void> {
    await this.loadSettings();

    const documents: DocumentStore = {
      read: async (path) => this.app.vault.read(this.requireMarkdownFile(path)),
      write: async (path, content) => this.app.vault.modify(this.requireMarkdownFile(path), content)
    };
    const reviews = new ReviewController(this.proposals, documents);
    this.navigator = document.createElement("aside");
    this.navigator.className = "code-design-navigator";
    this.navigator.hidden = true;
    document.body.append(this.navigator);
    this.register(() => this.navigator?.remove());
    this.outline = document.createElement("nav");
    this.outline.className = "code-design-outline";
    this.outline.ariaLabel = "Document outline";
    this.outline.dataset.disabled = String(!this.settings.outlineVisible);
    document.body.append(this.outline);
    this.register(() => this.outline?.remove());

    const unsubscribeProposalNavigation = this.proposals.subscribe((proposal) => {
      this.renderNavigator(proposal, reviews);
      if (!proposal) {
        this.navigatedProposalId = undefined;
      } else if (proposal.proposalId !== this.navigatedProposalId) {
        this.navigatedProposalId = proposal.proposalId;
        const firstFile = proposal.files[0]?.file;
        if (firstFile && this.app.workspace.getActiveFile()?.path !== firstFile) {
          void this.openProposalFile(firstFile);
        }
      }
    });
    this.register(unsubscribeProposalNavigation);
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      this.proposals.refresh();
      this.setOutlineAction(leaf?.view instanceof MarkdownView ? leaf.view : undefined);
    }));
    this.app.workspace.onLayoutReady(() => {
      this.setOutlineAction(this.app.workspace.getActiveViewOfType(MarkdownView) ?? undefined);
    });
    this.register(() => this.outlineAction?.remove());

    this.registerEditorExtension(
      createProposalEditorExtension(
        this.proposals,
        this.outline,
        () => this.app.workspace.getActiveFile()?.path,
        (markdown, container) => {
          void MarkdownRenderer.render(
            this.app,
            markdown,
            container,
            this.app.workspace.getActiveFile()?.path ?? "",
            this
          );
        }
      ) as Extension[]
    );

    this.server = new CodeDesignServer({
      store: this.proposals,
      getSelection: () => this.getSelection(),
      port: this.settings.port
    });

    try {
      const address = await this.server.start();
      this.addStatusBarItem().setText(`Code Design: ${address.port}`);
    } catch (error) {
      new Notice(`Code Design server failed: ${this.errorMessage(error)}`);
    }

    this.addSettingTab(new CodeDesignSettingTab(this.app, this));
  }

  async onunload(): Promise<void> {
    await this.server?.stop();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<CodeDesignSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...saved };
  }

  private setOutlineAction(view: MarkdownView | undefined): void {
    this.removeLegacyOutlineActions();
    if (view === this.outlineActionView) return;
    this.outlineAction?.remove();
    this.outlineAction = undefined;
    this.outlineActionView = view;
    if (!view) return;
    this.outlineAction = view.addAction("list-tree", this.outlineActionLabel(), () => {
      void this.toggleOutline();
    });
    this.outlineAction.classList.add("code-design-outline-action");
  }

  private removeLegacyOutlineActions(): void {
    const labels = ["Hide table of contents", "Show table of contents"];
    for (const label of labels) {
      const selector = `[aria-label="${label}"]:not(.code-design-outline-action)`;
      for (const action of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
        action.remove();
      }
    }
  }

  private async toggleOutline(): Promise<void> {
    this.settings.outlineVisible = !this.settings.outlineVisible;
    if (this.outline) {
      this.outline.dataset.disabled = String(!this.settings.outlineVisible);
    }
    this.outlineAction?.setAttribute("aria-label", this.outlineActionLabel());
    await this.saveSettings();
  }

  private outlineActionLabel(): string {
    return this.settings.outlineVisible
      ? "Hide table of contents"
      : "Show table of contents";
  }

  private getSelection(): Selection {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) return { kind: "none" };

    const browserSelection = window.getSelection();
    const anchor = browserSelection?.anchorNode;
    const selectedElement = anchor instanceof HTMLElement ? anchor : anchor?.parentElement ?? undefined;
    const focusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const element = this.proposalElement(selectedElement) ?? this.proposalElement(focusedElement);
    const explanation = element?.closest<HTMLElement>(".code-design-explanation");
    const addition = element?.closest<HTMLElement>(".code-design-addition");
    const deletion = element?.closest<HTMLElement>(".code-design-deletion");
    const card = element?.closest<HTMLElement>(".code-design-review");
    const proposal = this.proposals.getActive();
    const changeId = card?.dataset.changeId ?? addition?.dataset.changeId ?? deletion?.dataset.changeId;
    const locatedChange = proposal?.files
      .flatMap((file) => file.changes.map((change) => ({ file, change })))
      .find(({ change }) => change.id === changeId);
    if (explanation && proposal && locatedChange) {
      return {
        kind: "proposal_explanation",
        file: locatedChange.file.file,
        proposalId: proposal.proposalId,
        changeId: locatedChange.change.id,
        text: browserSelection?.toString() || locatedChange.change.explanation
      };
    }

    if ((addition || deletion) && proposal && locatedChange) {
      return {
        kind: "proposed_change",
        file: locatedChange.file.file,
        proposalId: proposal.proposalId,
        changeId: locatedChange.change.id,
        before: locatedChange.change.before,
        after: locatedChange.change.after
      };
    }
    const text = view.editor.getSelection();
    if (text.length > 0) {
      return {
        kind: "document",
        file: view.file.path,
        text,
        range: {
          from: view.editor.getCursor("from"),
          to: view.editor.getCursor("to")
        }
      };
    }

    return { kind: "none" };
  }

  private proposalElement(element: HTMLElement | undefined): HTMLElement | undefined {
    if (!element) return undefined;
    return element.closest<HTMLElement>(
      ".code-design-explanation, .code-design-addition, .code-design-deletion, .code-design-review"
    ) ?? undefined;
  }

  private requireMarkdownFile(path: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension !== "md") {
      throw new Error(`Markdown file not found in this vault: ${path}`);
    }
    return file;
  }

  private async openProposalFile(path: string): Promise<void> {
    try {
      const existing = this.app.vault.getAbstractFileByPath(path);
      const file = existing instanceof TFile ? existing : await this.app.vault.create(path, "");
      await this.app.workspace.getLeaf(false).openFile(file);
    } catch (error) {
      new Notice(`Code Design could not open ${path}: ${this.errorMessage(error)}`);
    }
  }

  private renderNavigator(
    proposal: Proposal | undefined,
    reviews: ReviewController
  ): void {
    const navigator = this.navigator;
    if (!navigator) return;
    const pending = proposal?.decision === undefined
      ? proposal?.files.flatMap((file) =>
          file.changes.map((change) => ({ file: file.file, change }))
        ) ?? []
      : [];
    navigator.replaceChildren();
    navigator.hidden = pending.length === 0;
    if (!proposal || pending.length === 0) return;

    const focused = this.proposals.getFocusedChangeId();
    const currentIndex = pending.findIndex(({ change }) => change.id === focused);
    const labelIndex = Math.max(0, currentIndex);
    const previous = this.navigationButton("↑", "Previous proposed change", () => {
      void this.navigateToPending(pending, currentIndex, -1);
    });
    const label = document.createElement("span");
    label.className = "code-design-navigator-label";
    label.textContent = `${pending.length} proposed ${pending.length === 1 ? "change" : "changes"} · ${pending[labelIndex].file}`;
    const actions = document.createElement("div");
    actions.className = "code-design-navigator-actions";
    const accept = this.verdictButton("Accept", "accepted", proposal, reviews);
    const reject = this.verdictButton("Reject", "rejected", proposal, reviews);
    actions.append(accept, reject);
    const navigation = document.createElement("div");
    navigation.className = "code-design-navigator-arrows";
    const next = this.navigationButton("↓", "Next proposed change", () => {
      void this.navigateToPending(pending, currentIndex, 1);
    });
    navigation.append(previous, next);
    navigator.append(label, actions, navigation);
  }

  private verdictButton(
    label: string,
    decision: "accepted" | "rejected",
    proposal: Proposal,
    reviews: ReviewController
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `code-design-verdict code-design-${decision}`;
    button.textContent = label;
    button.addEventListener("click", () => {
      const buttons = this.navigator?.querySelectorAll("button") ?? [];
      for (const candidate of Array.from(buttons)) {
        candidate.disabled = true;
      }
      void reviews.resolve(proposal.proposalId, decision).catch((error: unknown) => {
        new Notice(this.errorMessage(error));
        this.renderNavigator(this.proposals.getActive(), reviews);
      });
    });
    return button;
  }

  private navigationButton(label: string, ariaLabel: string, action: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.ariaLabel = ariaLabel;
    button.addEventListener("click", action);
    return button;
  }

  private async navigateToPending(
    pending: Array<{ file: string; change: { id: string } }>,
    currentIndex: number,
    direction: -1 | 1
  ): Promise<void> {
    const targetIndex = pending.length === 1
      ? 0
      : currentIndex < 0
        ? direction === 1 ? 0 : pending.length - 1
        : (currentIndex + direction + pending.length) % pending.length;
    const target = pending[targetIndex];
    this.proposals.focus(target.change.id);
    if (this.app.workspace.getActiveFile()?.path !== target.file) {
      await this.openProposalFile(target.file);
      this.proposals.refresh();
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
