import type {Empty, LinkedBundle} from '@devvit/protos'
import {throttle} from '@devvit/shared-types/throttle.js'
import type {DevvitUIError} from '@devvit/ui-renderer/client/devvit-custom-post.js'
import type {VirtualTypeScriptEnvironment} from '@typescript/vfs'
import {
  LitElement,
  css,
  html,
  unsafeCSS,
  type CSSResultGroup,
  type PropertyValues,
  type TemplateResult
} from 'lit'
import {customElement, property, query, state} from 'lit/decorators.js'
import {ifDefined} from 'lit/directives/if-defined.js'
import {
  appEntrypointFilename,
  compile,
  newTSEnv,
  setSource
} from '../../bundler/compiler.js'
import {link} from '../../bundler/linker.js'
import clock from '../../examples/clock.example.tsx'
import defaultExample from '../../examples/default.example.tsx'
import helloBlocks from '../../examples/hello-blocks.example.tsx'
import polls from '../../examples/polls.example.tsx'
import progressBar from '../../examples/progress-bar.example.tsx'
import svg from '../../examples/svg.example.tsx'
import {BundleStore} from '../../runtime/bundle-store.js'
import {PenSave, loadPen, penToHash, savePen} from '../../storage/pen-save.js'
import {
  defaultSettings,
  loadSettings,
  saveSettings
} from '../../storage/settings-save.js'
import type {ColorScheme} from '../../types/color-scheme.js'
import type {Diagnostics} from '../../types/diagnostics.js'
import {newHostname} from '../../utils/compute-util.js'
import {cssReset} from '../../utils/css-reset.js'
import type {OpenLine} from '../play-console.js'
import type {PlayEditor} from '../play-editor/play-editor.js'
import type {PlayToast} from '../play-toast.js'
import penVars from './pen-vars.css'

import '../play-editor/play-editor.js'
import '../play-pen-footer.js'
import '../play-pen-header.js'
import '../play-preview-controls.js'
import '../play-preview.js'
import '../play-toast.js'

declare global {
  interface HTMLElementTagNameMap {
    'play-pen': PlayPen
  }
}

/**
 * A complete and standalone playground: an editor, a runtime and client, a
 * preview and toolbar. Accepts a slotted template.
 *
 * @slot - Optional template.
 */
@customElement('play-pen')
export class PlayPen extends LitElement {
  static override readonly styles: CSSResultGroup = css`
    ${cssReset}

    ${unsafeCSS(penVars)}

    :host {
      /* Light mode. */
      color: var(--color-foreground);
      background-color: var(--color-background);

      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;

      /* Dark and light schemes are supported. */
      color-scheme: dark light;
    }

    play-editor {
      width: 100%;
      flex-grow: 1;
      flex-shrink: 1;
    }

    .preview {
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      row-gap: 8px;
    }

    main {
      column-gap: 16px;
      display: flex;
      flex-direction: row;
      overflow: clip;
      padding-right: 16px;
      padding-left: 16px;
      row-gap: 16px;
      height: 100%;
      background-color: var(--color-background);
      z-index: var(--z-base);
    }

    /* Makes dropdowns appear over other content */
    play-pen-header,
    play-pen-footer {
      z-index: var(--z-menu);
    }
  `

  /**
   * Allow loading and saving from LocalStorage. Do not enable for multiple
   * playgrounds on the same document.
   */
  @property({attribute: 'allow-storage', type: Boolean}) allowStorage: boolean =
    false
  /**
   * Allow loading and saving from URL hash. Loading from hash has precedence
   * over LocalStorage. Do not enable for multiple playgrounds on the same
   * document.
   */
  @property({attribute: 'allow-url', type: Boolean}) allowURL: boolean = false
  @property({attribute: false}) srcByLabel: Readonly<{[key: string]: string}> =
    {
      Default: defaultExample, // The default can be overridden by the slot.
      'Hello Blocks!': helloBlocks,
      'Progress Bar': progressBar,
      Clock: clock,
      Polls: polls,
      SVG: svg
    }

  /** Program executable. */
  @state() private _bundle?: Readonly<LinkedBundle> | undefined
  /** Execution preview widths. */
  @state() private _diagnostics: Diagnostics = {previewErrs: [], tsErrs: []}
  @state() private _openConsole: boolean = false
  @state() private _previewWidth: number = 288
  @state() private _remoteRuntimeOrigin: string =
    defaultSettings.remoteRuntimeOrigin
  @state() private _runtimeDebugLogging: boolean = false
  @state() private _sandboxApp: boolean = false
  @state() private _useExperimentalBlocks: boolean = false
  @state() private _useLocalRuntime: boolean = false
  @state() private _useRemoteRuntime: boolean = false
  @state() private _useUIRequest: boolean = false
  @query('play-editor') private _editor!: PlayEditor
  @query('play-toast') private _toast!: PlayToast
  #bundleStore?: BundleStore | undefined
  readonly #env: VirtualTypeScriptEnvironment = newTSEnv()
  @state() _uploaded: Promise<Empty> = Promise.resolve({})
  /** Try to ensure the bundle hostname is unique. See compute-util. */
  #version: number = Date.now()

  /** Program title. */ @state() private _name: string = ''
  /** Execution color scheme. */ @state() private _scheme:
    | ColorScheme
    | undefined
  /** Program source code. Undefined when not restored. */ @state()
  private _src: string | undefined
  #template?: boolean

  override connectedCallback(): void {
    super.connectedCallback()

    const settings =
      (this.allowStorage ? loadSettings(localStorage) : undefined) ??
      defaultSettings
    if (settings) {
      this._openConsole = settings.openConsole
      this._remoteRuntimeOrigin = settings.remoteRuntimeOrigin
      this._runtimeDebugLogging = settings.runtimeDebugLogging
      this._sandboxApp = settings.sandboxApp
      this._useExperimentalBlocks = settings.useExperimentalBlocks
      this._useLocalRuntime = settings.useLocalRuntime
      this._useRemoteRuntime = settings.useRemoteRuntime
      this._useUIRequest = settings.useUIRequest
      // If remote is enabled, #bundleStore is initialized in willUpdate() and
      // bundle is loaded.
    }

    let pen
    if (this.allowURL) pen = loadPen(location)
    if (this.allowStorage) pen ??= loadPen(localStorage)
    if (!pen) {
      this.#template = true
      this.#setSrc(helloBlocks, false)
      return
    }
    this.#setSrc(pen.src, false)
    this.#setName(pen.name, false)
  }

  protected override render(): TemplateResult {
    return html`
      <play-toast>Copied the URL!</play-toast
      ><play-pen-header
        ?allow-storage=${this.allowStorage}
        name=${this._name}
        remote-runtime-origin=${this._remoteRuntimeOrigin}
        ?runtime-debug-logging=${this._runtimeDebugLogging}
        ?sandbox-app=${this._sandboxApp}
        .srcByLabel=${this.srcByLabel}
        url=${this.#shareURL().toString()}
        ?use-experimental-blocks=${this._useExperimentalBlocks}
        ?use-local-runtime=${this._useLocalRuntime}
        ?use-remote-runtime=${this._useRemoteRuntime}
        ?use-ui-request=${this._useUIRequest}
        @edit-name=${(ev: CustomEvent<string>) =>
          this.#setName(ev.detail, true)}
        @edit-src=${(ev: CustomEvent<string>) => {
          this.#setSrc(ev.detail, false)
          this.#setName('', false)
          this._editor.setSrc(ev.detail)
        }}
        @runtime-debug-logging=${(ev: CustomEvent<boolean>) =>
          (this._runtimeDebugLogging = ev.detail)}
        @sandbox-app=${(ev: CustomEvent<boolean>) =>
          (this._sandboxApp = ev.detail)}
        @use-experimental-blocks=${(ev: CustomEvent<boolean>) =>
          (this._useExperimentalBlocks = ev.detail)}
        @use-local-runtime=${(ev: CustomEvent<boolean>) =>
          (this._useLocalRuntime = ev.detail)}
        @use-remote-runtime=${(ev: CustomEvent<boolean>) =>
          (this._useRemoteRuntime = ev.detail)}
        @edit-remote-runtime-origin=${(ev: CustomEvent<string>) =>
          (this._remoteRuntimeOrigin = ev.detail)}
        @use-ui-request=${(ev: CustomEvent<boolean>) =>
          (this._useUIRequest = ev.detail)}
        @share=${this.#onShare}
      ></play-pen-header>
      <main>
        <play-editor
          .env=${this.#env}
          src=${ifDefined(this._src)}
          @edit=${(ev: CustomEvent<string>) => this.#setSrc(ev.detail, true)}
          @edit-template=${(ev: CustomEvent<string>) => {
            this.srcByLabel = {...this.srcByLabel, ['Default']: ev.detail}
            if (!this.#template) return
            // If no source was restored, use the template.
            this.#setSrc(ev.detail, false)
            this._editor.setSrc(ev.detail)
          }}
          ><slot></slot
        ></play-editor>
        <div class="preview">
          <play-preview
            .bundle=${this._bundle}
            previewWidth=${this._previewWidth}
            remote-runtime-origin=${this._remoteRuntimeOrigin}
            ?runtime-debug-logging=${this._runtimeDebugLogging}
            ?sandbox-app=${this._sandboxApp}
            scheme=${ifDefined(this._scheme)}
            .uploaded=${this._uploaded}
            ?use-experimental-blocks=${this._useExperimentalBlocks}
            ?use-local-runtime=${this._useLocalRuntime}
            ?use-remote-runtime=${this._useRemoteRuntime}
            ?use-ui-request=${this._useUIRequest}
            @clear-errors=${() => this.#clearPreviewErrors()}
            @devvit-ui-error=${(ev: CustomEvent<DevvitUIError>) =>
              this.#appendPreviewError(ev.detail)}
          ></play-preview>
          <play-preview-controls
            previewWidth=${this._previewWidth}
            scheme=${ifDefined(this._scheme)}
            @preview-reset=${() => {
              if (this._bundle) this._bundle = {...this._bundle}
            }}
            @preview-width=${(ev: CustomEvent<number>) =>
              (this._previewWidth = ev.detail)}
            @preview-scheme=${(ev: CustomEvent<ColorScheme | undefined>) =>
              (this._scheme = ev.detail)}
          ></play-preview-controls>
        </div>
      </main>
      <play-pen-footer
        .diagnostics=${this._diagnostics}
        ?open-console=${this._openConsole}
        @open-console=${(ev: CustomEvent<boolean>) =>
          (this._openConsole = ev.detail)}
        @preview-width=${(ev: CustomEvent<number>) =>
          (this._previewWidth = ev.detail)}
        @preview-scheme=${(ev: CustomEvent<ColorScheme | undefined>) =>
          (this._scheme = ev.detail)}
        @open-line=${(ev: CustomEvent<OpenLine>) =>
          this._editor.openLine(ev.detail.line, ev.detail.char)}
      ></play-pen-footer>
    `
  }

  protected override async willUpdate(
    props: PropertyValues<this> &
      PropertyValues<{
        _openConsole: boolean
        _runtimeDebugLogging: boolean
        _sandboxApp: boolean
        _useExperimentalBlocks: boolean
        _useLocalRuntime: boolean
        _useRemoteRuntime: boolean
        _remoteRuntimeOrigin: string
        _useUIRequest: boolean
      }>
  ): Promise<void> {
    super.willUpdate(props)

    if (
      this.allowStorage &&
      (props.has('_openConsole') ||
        props.has('_runtimeDebugLogging') ||
        props.has('_sandboxApp') ||
        props.has('_useExperimentalBlocks') ||
        props.has('_remoteRuntimeOrigin') ||
        props.has('_useLocalRuntime') ||
        props.has('_useRemoteRuntime') ||
        props.has('_useUIRequest'))
    )
      saveSettings(localStorage, {
        openConsole: this._openConsole,
        runtimeDebugLogging: this._runtimeDebugLogging,
        sandboxApp: this._sandboxApp,
        useExperimentalBlocks: this._useExperimentalBlocks,
        useLocalRuntime: this._useLocalRuntime,
        useRemoteRuntime: this._useRemoteRuntime,
        remoteRuntimeOrigin: this._remoteRuntimeOrigin,
        useUIRequest: this._useUIRequest,
        version: 1
      })

    if (props.has('_remoteRuntimeOrigin'))
      this.#bundleStore = BundleStore(this._remoteRuntimeOrigin)

    if (props.has('_useRemoteRuntime') || props.has('_remoteRuntimeOrigin'))
      this.#upload()
  }

  #appendPreviewError(err: DevvitUIError): void {
    this._diagnostics = {
      ...this._diagnostics,
      previewErrs: [...this._diagnostics.previewErrs, err]
    }
  }

  #clearPreviewErrors(): void {
    if (this._diagnostics) this._diagnostics.previewErrs.length = 0
    this._diagnostics = {...this._diagnostics}
  }

  async #onShare(): Promise<void> {
    await navigator.clipboard.writeText(this.#shareURL().toString())
    this._toast.open()
  }

  /** Save to LocalStorage and URL as allowed. */
  #save(): void {
    savePen(
      this.allowURL ? location : undefined,
      this.allowStorage ? localStorage : undefined,
      PenSave(this._name, this._src ?? '')
    )
  }

  #setName(name: string, save: boolean): void {
    this._name = name
    if (save) this.#save()
  }

  #setSrc(src: string, save: boolean): void {
    this._src = src
    setSource(this.#env, src)
    this.#env.updateFile(appEntrypointFilename, src || ' ') // empty strings trigger file deletion!
    this._diagnostics = {
      ...this._diagnostics,
      tsErrs: this.#env.languageService.getSemanticDiagnostics(
        appEntrypointFilename
      )
    }
    this.#setSrcSideEffects(save)
  }

  /** Throttled changes after updating sources. */
  #setSrcSideEffects = throttle((save: boolean): void => {
    this.#version++
    this._bundle = link(
      compile(this.#env),
      newHostname(this._name, this.#version)
    )
    if (save) this.#save()
    this.#upload()
  }, 500)

  /** Recompute the current hash regardless of the location bar state. */
  #shareURL(): URL {
    const url = new URL(location.toString())
    url.hash = penToHash(PenSave(this._name, this._src ?? ''))
    return url
  }

  #upload(): void {
    // Unlike production, bundles are first available locally and then remotely.
    // Upload failures appear in the execution of RemoteApp.
    if (this._useRemoteRuntime && this._bundle)
      this._uploaded =
        this.#bundleStore?.upload(this._bundle) ?? Promise.resolve({})
  }
}
