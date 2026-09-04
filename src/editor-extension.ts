import { type EditorState, type Range, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type ViewUpdate,
  ViewPlugin,
  WidgetType
} from "@codemirror/view";

import type { Proposal, ProposalFile, ProposedChange } from "./contracts";
import type { ProposalStore } from "./proposal-store";

interface VisibleProposal {
  proposal: Proposal;
  file: ProposalFile;
}

const refreshProposal = StateEffect.define<VisibleProposal | undefined>();

class AdditionWidget extends WidgetType {
  constructor(
    private readonly change: ProposedChange,
    private readonly renderMarkdown: MarkdownRenderer,
    private readonly block: boolean
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const element = document.createElement(this.block ? "div" : "span");
    element.className = "code-design-addition";
    if (this.block) element.classList.add("markdown-rendered");
    element.classList.add(
      this.block ? "code-design-addition-block" : "code-design-addition-inline"
    );
    if (this.change.before.length > 0) {
      element.classList.add("code-design-addition-replacement");
    }
    element.dataset.changeId = this.change.id;
    element.tabIndex = 0;
    this.renderMarkdown(this.change.after, element);
    return element;
  }
}

type MarkdownRenderer = (markdown: string, container: HTMLElement) => void;

class ReviewWidget extends WidgetType {
  constructor(private readonly change: ProposedChange) {
    super();
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "code-design-review-wrapper";
    const card = document.createElement("aside");
    card.className = "code-design-review";
    card.classList.add(
      this.change.after.length > 0
        ? "code-design-review-addition"
        : "code-design-review-deletion"
    );
    card.dataset.changeId = this.change.id;

    if (this.change.explanation.length > 0) {
      const explanation = document.createElement("p");
      explanation.className = "code-design-explanation";
      explanation.textContent = this.change.explanation;
      explanation.tabIndex = 0;
      card.append(explanation);
    }

    wrapper.append(card);
    return wrapper;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function decorationsFor(
  state: EditorState,
  proposal: Proposal | undefined,
  file: ProposalFile | undefined,
  renderMarkdown: MarkdownRenderer,
): DecorationSet {
  if (!proposal || !file) return Decoration.none;
  const ranges: Array<Range<Decoration>> = [];
  const length = state.doc.length;
  if (proposal.decision !== undefined) return Decoration.none;
  for (const change of file.changes) {
    if (change.to > length) continue;
    const changedLine = state.doc.lineAt(change.to);
    const additionPosition = change.to === changedLine.from ? change.to : changedLine.to;
    const block = true;
    if (change.from < change.to) {
      ranges.push(
        Decoration.mark({
          class: "code-design-deletion",
          attributes: { "data-change-id": change.id }
        }).range(change.from, change.to)
      );
    }
    if (change.after.length > 0) {
      ranges.push(
        Decoration.widget({
          widget: new AdditionWidget(change, renderMarkdown, block),
          block,
          side: 1
        }).range(additionPosition)
      );
    }
    if (change.explanation.length > 0) {
      ranges.push(
        Decoration.widget({
          block: true,
          side: 2,
          widget: new ReviewWidget(change)
        }).range(additionPosition)
      );
    }
  }
  return Decoration.set(ranges, true);
}

export function createProposalEditorExtension(
  proposals: ProposalStore,
  outline: HTMLElement,
  currentFile: () => string | undefined,
  renderMarkdown: MarkdownRenderer
): readonly unknown[] {
  interface ProposalDecorationState {
    visible: VisibleProposal | undefined;
    decorations: DecorationSet;
  }

  const proposalState = StateField.define<ProposalDecorationState>({
    create: () => ({ visible: undefined, decorations: Decoration.none }),
    update(value, transaction) {
      let visible = value.visible;
      for (const effect of transaction.effects) {
        if (effect.is(refreshProposal)) visible = effect.value;
      }
      return {
        visible,
        decorations: decorationsFor(
          transaction.state,
          visible?.proposal,
          visible?.file,
          renderMarkdown
        )
      };
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
  });

  const plugin = ViewPlugin.fromClass(
    class {
      private readonly unsubscribe: () => void;
      private destroyed = false;
      private scrollKey: string | undefined;
      private outlineHeadings: Array<{ from: number; link: HTMLButtonElement }> = [];
      private readonly renderOutlineListener = (): void => this.renderOutline();
      private readonly updateActiveHeadingListener = (): void => this.updateActiveHeading();

      constructor(private readonly view: EditorView) {
        window.addEventListener("resize", this.renderOutlineListener);
        this.view.scrollDOM.addEventListener("scroll", this.updateActiveHeadingListener, {
          passive: true
        });
        queueMicrotask(() => this.renderOutline());
        this.unsubscribe = proposals.subscribe((proposal) => {
          const file = proposal?.files.find((candidate) => candidate.file === currentFile());
          const visible = proposal && file ? { proposal, file } : undefined;
          // ProposalStore publishes immediately during subscription. CodeMirror does not
          // permit a dispatch while it constructs a view plugin.
          queueMicrotask(() => {
            if (this.destroyed) return;
            if (visible) {
              const pending = visible.proposal.decision === undefined
                ? visible.file.changes
                : [];
              const requested = proposals.getFocusedChangeId();
              const target = pending.find((change) => change.id === requested);
              const nextScrollKey = target
                ? `${visible.proposal.proposalId}:${target.id}`
                : undefined;
              if (target && nextScrollKey !== this.scrollKey) {
                this.scrollKey = nextScrollKey;
                this.view.dispatch({
                  effects: [
                    refreshProposal.of(visible),
                    EditorView.scrollIntoView(
                      Math.min(target.from, this.view.state.doc.length),
                      { y: "center" }
                    )
                  ]
                });
                return;
              }
            }
            this.view.dispatch({ effects: refreshProposal.of(visible) });
          });
        });
      }

      update(update: ViewUpdate): void {
        if (update.docChanged) this.renderOutline();
        else if (update.viewportChanged) this.updateActiveHeading();
      }

      destroy(): void {
        this.destroyed = true;
        this.unsubscribe();
        window.removeEventListener("resize", this.renderOutlineListener);
        this.view.scrollDOM.removeEventListener("scroll", this.updateActiveHeadingListener);
      }

      private renderOutline(): void {
        const viewBounds = this.view.dom.getBoundingClientRect();
        const content = this.view.dom.querySelector<HTMLElement>(".cm-contentContainer")
          ?? this.view.contentDOM;
        const contentBounds = content.getBoundingClientRect();
        const availableWidth = contentBounds.left - viewBounds.left - 24;
        outline.hidden = availableWidth < 180 || viewBounds.height < 240;
        if (outline.hidden) return;

        outline.style.left = `${viewBounds.left + 12}px`;
        outline.style.top = `${viewBounds.top + 16}px`;
        outline.style.width = `${availableWidth}px`;
        outline.style.maxHeight = `${Math.max(160, viewBounds.height - 112)}px`;
        outline.replaceChildren();
        this.outlineHeadings = [];
        const file = currentFile();
        if (file) {
          const title = document.createElement("button");
          title.type = "button";
          title.className = "code-design-outline-title";
          title.textContent = file.split("/").at(-1)?.replace(/\.md$/i, "") ?? file;
          title.addEventListener("click", () => {
            this.setActiveHeading(-1);
            this.view.scrollDOM.scrollTo({ top: 0, behavior: "auto" });
          });
          outline.append(title);
        }
        let fence: "```" | "~~~" | undefined;
        for (let number = 1; number <= this.view.state.doc.lines; number += 1) {
          const line = this.view.state.doc.line(number);
          const fenceMatch = line.text.match(/^\s*(```|~~~)/);
          if (fenceMatch) {
            const marker = fenceMatch[1] as "```" | "~~~";
            fence = fence === marker ? undefined : fence ?? marker;
            continue;
          }
          if (fence) continue;
          const heading = line.text.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
          if (!heading) continue;
          const link = document.createElement("button");
          link.type = "button";
          link.className = "code-design-outline-link";
          link.dataset.depth = heading[1].length.toString();
          this.renderHeadingLabel(link, heading[2]);
          link.title = heading[2];
          const headingIndex = this.outlineHeadings.length;
          link.addEventListener("click", () => {
            this.navigateToHeading(headingIndex);
          });
          outline.append(link);
          this.outlineHeadings.push({ from: line.from, link });
        }
        this.updateActiveHeading();
      }

      private updateActiveHeading(): void {
        this.view.requestMeasure({
          key: this.updateActiveHeadingListener,
          read: (view) => {
            if (outline.hidden || this.outlineHeadings.length === 0) return -1;
            const scrollerTop = view.scrollDOM.getBoundingClientRect().top;
            const heightFromDocumentTop = scrollerTop + 40 - view.documentTop;
            const top = view.lineBlockAtHeight(heightFromDocumentTop).from;
            let activeIndex = -1;
            for (const [index, heading] of this.outlineHeadings.entries()) {
              if (heading.from > top) break;
              activeIndex = index;
            }
            return activeIndex;
          },
          write: (activeIndex) => this.setActiveHeading(activeIndex)
        });
      }

      private setActiveHeading(activeIndex: number): void {
        const title = outline.querySelector<HTMLElement>(".code-design-outline-title");
        const titleIsActive = activeIndex < 0;
        title?.classList.toggle("is-active", titleIsActive);
        if (titleIsActive) title?.setAttribute("aria-current", "location");
        else title?.removeAttribute("aria-current");
        for (const [index, heading] of this.outlineHeadings.entries()) {
          const isActive = index === activeIndex;
          heading.link.classList.toggle("is-active", isActive);
          if (isActive) heading.link.setAttribute("aria-current", "location");
          else heading.link.removeAttribute("aria-current");
        }
      }

      private navigateToHeading(headingIndex: number): void {
        const heading = this.outlineHeadings[headingIndex];
        if (!heading) return;
        this.setActiveHeading(headingIndex);
        this.view.dispatch({
          selection: { anchor: heading.from },
          effects: EditorView.scrollIntoView(heading.from, { y: "start", yMargin: 32 })
        });
        this.view.focus();
      }

      private renderHeadingLabel(link: HTMLElement, label: string): void {
        this.renderHeadingInline(link, label);
      }

      private renderHeadingInline(parent: HTMLElement, text: string): void {
        const delimiters = [
          { open: "`", close: "`", tag: "code", className: "code-design-outline-code" },
          { open: "**", close: "**", tag: "strong", className: "code-design-outline-bold" },
          { open: "__", close: "__", tag: "strong", className: "code-design-outline-bold" },
          { open: "~~", close: "~~", tag: "del", className: "code-design-outline-strikethrough" },
          { open: "*", close: "*", tag: "em", className: "code-design-outline-italic" },
          { open: "_", close: "_", tag: "em", className: "code-design-outline-italic" }
        ] as const;
        let cursor = 0;
        while (cursor < text.length) {
          const opening = delimiters
            .map((delimiter) => ({
              delimiter,
              index: this.findHeadingDelimiter(text, delimiter.open, cursor, "open")
            }))
            .filter((candidate) => candidate.index >= 0)
            .sort((left, right) =>
              left.index - right.index || right.delimiter.open.length - left.delimiter.open.length
            )[0];
          if (!opening) {
            parent.append(document.createTextNode(text.slice(cursor)));
            return;
          }
          const contentStart = opening.index + opening.delimiter.open.length;
          const closing = this.findHeadingDelimiter(
            text,
            opening.delimiter.close,
            contentStart,
            "close"
          );
          if (closing < 0) {
            parent.append(document.createTextNode(text.slice(cursor)));
            return;
          }
          if (opening.index > cursor) {
            parent.append(document.createTextNode(text.slice(cursor, opening.index)));
          }
          const element = document.createElement(opening.delimiter.tag);
          element.className = opening.delimiter.className;
          const content = text.slice(contentStart, closing);
          if (opening.delimiter.open === "`") element.textContent = content;
          else this.renderHeadingInline(element, content);
          parent.append(element);
          cursor = closing + opening.delimiter.close.length;
        }
      }

      private findHeadingDelimiter(
        text: string,
        delimiter: string,
        start: number,
        side: "open" | "close"
      ): number {
        if (delimiter !== "_") return text.indexOf(delimiter, start);
        let index = text.indexOf(delimiter, start);
        while (index >= 0) {
          const before = text[index - 1];
          const after = text[index + 1];
          const valid = side === "open"
            ? (!before || !/[A-Za-z0-9]/.test(before)) && Boolean(after && !/\s/.test(after))
            : Boolean(before && !/\s/.test(before)) && (!after || !/[A-Za-z0-9]/.test(after));
          if (valid) return index;
          index = text.indexOf(delimiter, index + 1);
        }
        return -1;
      }
    }
  );

  return [proposalState, plugin];
}
