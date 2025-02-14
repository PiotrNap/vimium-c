import { kPgReq } from "../background/page_messages"
import { $, OnEdge, browser_, OnFirefox, OnChrome, nextTick_, CurCVer_, IsEdg_, post_ } from "./async_bg"
import { Option_, KnownOptionsDataset, oTrans_, bgSettings_ } from "./options_base"
import { registerClass, createNewOption, TextOption_ } from "./options_defs"
import kPermissions = chrome.permissions.kPermissions

type AllowedApi = "contains" | "request" | "remove"

//#region Api wrapper
type PromisifyApi1<F> = F extends ((...args: [...infer A, (res: infer R, ex?: FakeArg) => void]) => void | 1)
    ? (...args: A) => Promise<ExtApiResult<R>> : never
type PromisifyApi<F extends Function> =
    F extends { (...args: infer A1): infer R1; (...args: infer A2): infer R2 }
    ? PromisifyApi1<(...args: A1) => R1> | PromisifyApi1<(...args: A2) => R2>
    : PromisifyApi1<F>
// When loading Vimium C on Chrome 60 startup using scripts/chrome2.sh, an options page may have no chrome.permissions
const _rawPermissionAPI = OnEdge ? null as never : browser_.permissions
const wrapApi = ((funcName: AllowedApi): Function => {
  if (!_rawPermissionAPI) {
    return function () {
      return post_(kPgReq.callApi, { module: "permissions", name: funcName, args: [].slice.call(arguments) })
    }
  }
  const func = _rawPermissionAPI[funcName as "contains"] as (args: unknown[]) => void | Promise<unknown>
  return function () {
    const arr: unknown[] = [].slice.call(arguments)
    if (!OnChrome) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      return (func.apply(_rawPermissionAPI, arr as any) as Promise<unknown>).then(i => [i, void 0]
          , err => [void 0, err as { message?: unknown}])
    }
    return new Promise<ExtApiResult<unknown>>((resolve): void => {
      arr.push((res: unknown): void => {
        const err = browser_.runtime.lastError as unknown
        resolve(err ? [void 0, err as { message?: unknown }] : [res, void 0])
        return err as void
      })
      void func.apply(_rawPermissionAPI, arr as any) // eslint-disable-line @typescript-eslint/no-unsafe-argument
    })
  }
}) as <T extends AllowedApi> (funcName: T) => PromisifyApi<typeof chrome.permissions[T]>
const browserPermissions_ = OnEdge ? null as never : {
  contains: wrapApi("contains"), request: wrapApi("request"), remove: wrapApi("remove")
}
//#endregion

interface PermissionItem { name_: kPermissions; previous_: 0 | 1 | 2; element_: HTMLInputElement }

const kShelf = "downloads.shelf", kNTP = "chrome://new-tab-page/*", kCrURL = "chrome://*/*"
const i18nItems = {
  [kCrURL]: "opt_chromeUrl",
  [kNTP]: "opt_cNewtab",
  [kShelf]: "opt_closeShelf"
} as const
const placeholder = <true> !OnEdge && $<HTMLTemplateElement & EnsuredMountedHTMLElement>("#optionalPermissionsTemplate")
const template = <true> !OnEdge && placeholder.content.firstElementChild as HTMLElement
const container = <true> !OnEdge && placeholder.parentElement
const shownItems: PermissionItem[] = []
export const manifest = browser_.runtime.getManifest() as Readonly<chrome.runtime.Manifest>
let optional_permissions = (!OnEdge && manifest.optional_permissions || []) as readonly kPermissions[]

export class OptionalPermissionsOption_ extends Option_<"nextPatterns"> {
  override init_ (): void { this.element_.onchange = this.onUpdated_ }
  override readValueFromElement_ = (): string => shownItems.map(
      i => i.element_.checked ? i.element_.indeterminate ? "1" : "2" : "0").join("")
  override innerFetch_ = (): string => shownItems.map(i => i.previous_).join("")
  override populateElement_ (value: string): void {
    for (let i = 0; i < shownItems.length; i++) {
      shownItems[i].element_.checked = value[i] !== "0"
      shownItems[i].element_.indeterminate = value[i] === "1"
    }
  }
  override executeSave_ (wanted_value: string): Promise<string> {
    const new_permissions: kPermissions[] = [], new_origins: kPermissions[] = []
    const changed: { [key in kPermissions]?: PermissionItem } = {}
    let waiting = 1
    for (let _ind = 0; _ind < shownItems.length; _ind++) {
      const i = shownItems[_ind]
      const wanted = +wanted_value[_ind] as 0 | 1 | 2
      if (i.previous_ === wanted) { continue }
      const orig2: kPermissions | "" = i.name_ === kNTP ? "chrome://newtab/*" : ""
      i.previous_ = wanted
      if (i.name_ === kCrURL) {
        if (<boolean> bgSettings_.get_("allBrowserUrls") !== (wanted === 2)) {
          void bgSettings_.set_("allBrowserUrls", wanted === 2)
        }
      }
      if (wanted) {
        i.name_ === kShelf && new_permissions.push("downloads");
        (i.name_.includes(":") ? new_origins : new_permissions).push(i.name_)
        orig2 && new_origins.push(orig2)
        changed[i.name_] = i
      } else {
        waiting++
        void browserPermissions_.remove(i.name_.includes(":") ? { origins: orig2 ? [i.name_, orig2] : [i.name_] } : {
          permissions: i.name_ === kShelf ? ["downloads", i.name_] : [i.name_]
        }).then(([ok, err]): void => {
          const msg1 = "Can not remove the permission %o :", msg2 = err && err.message || err;
          (err || !ok) && console.log(msg1, i.name_, msg2)
          const box = i.element_.parentElement as Element as EnsuredMountedHTMLElement
          TextOption_.showError_(err ? msg1.replace("%o", i.name_) + msg2 : "", void 0, box)
          tryRefreshing()
        })
      }
    }
    const cb = (arr: kPermissions[], [ok, err]: ExtApiResult<boolean>): void => {
      (err || !ok) && console.log("Can not request permissions of %o :", arr, err && err.message || err)
      if (!ok) {
        for (const name of arr) {
          const item = changed[name]
          if (!item) { continue }
          item.previous_ = 0
          const box = item.element_.parentElement as Element as EnsuredMountedHTMLElement
          if (!err) { return TextOption_.showError_("", void 0, box)  }
          let msg = (err && err.message || JSON.stringify(err)) + ""
          if (name.startsWith("chrome://") && msg.includes("Only permissions specified in the manifest")) {
            if (name.startsWith("chrome:")) {
              msg = oTrans_("optNeedChromeUrlFirst")
              msg = IsEdg_ ? msg.replace("chrome:", "edge:") : msg
            }
          }
          msg = oTrans_("exc") + msg
          TextOption_.showError_(msg, void 0, box)
          nextTick_((): void => { box.title = msg })
        }
        void this.fetch_()
      }
      tryRefreshing()
    }
    const tryRefreshing = (): void => {
      waiting--
      if (waiting > 0) { return }
      void Promise.all(shownItems.map(doPermissionsContain_)).then(() => {
        void this.fetch_()
      })
    }
    waiting += (new_permissions.length && 1) + (new_origins.length && 1)
    new_permissions.length &&
        browserPermissions_.request({ permissions: new_permissions }).then(cb.bind(0, new_permissions))
    new_origins.length && browserPermissions_.request({ origins: new_origins }).then(cb.bind(0, new_origins))
    tryRefreshing()
    return Promise.resolve(wanted_value)
  }
}
OnEdge || registerClass("OptionalPermissions", OptionalPermissionsOption_)

const initOptionalPermissions = (): void => {
  const fragment = document.createDocumentFragment()
  if (OnFirefox && bgSettings_.os_ === kOS.unixLike) {
    template.querySelector("input")!.classList.add("baseline")
  }
  let itemInd = 0
  for (const name of optional_permissions) {
    const node = document.importNode(template, true) as EnsuredMountedHTMLElement
    const checkbox = node.querySelector("input")!
    const i18nKey = i18nItems[name as keyof typeof i18nItems]
    checkbox.value = name
    let i18nName = oTrans_(i18nKey || `opt_${name}`) || name
    let suffix = ""
    if (name.startsWith("chrome:")) {
      i18nName = IsEdg_ ? i18nName.replace("chrome:", "edge:") : i18nName
      suffix = oTrans_("optOfChromeUrl").replace(IsEdg_ ? "chrome" : "edge", "edge")
    }
    if (name === kNTP) {
      if (OnChrome && Build.MinCVer < BrowserVer.MinChromeURL$NewTabPage
          && CurCVer_ < BrowserVer.MinChromeURL$NewTabPage) {
        suffix = oTrans_("requireChromium", [BrowserVer.MinChromeURL$NewTabPage])
        checkbox.disabled = true
        checkbox.checked = false
        node.title = oTrans_("invalidOption", [oTrans_("beforeChromium", [BrowserVer.MinChromeURL$NewTabPage])])
      }
    }
    node.lastElementChild.textContent = i18nName + suffix
    if (optional_permissions.length === 1) {
      node.classList.add("single")
    }
    fragment.appendChild(node)
    shownItems[itemInd++].element_ = checkbox
  }
  container.appendChild(fragment)
  container.addEventListener("change", onChange, true)
}

const doPermissionsContain_ = (item: PermissionItem): Promise<void> => {
  const name = item.name_
  let resolve: () => void, p = new Promise<void>(curResolve => { resolve = curResolve })
  void browserPermissions_.contains(name.includes(":") ? { origins: [name] }
      : { permissions: name === kShelf ? ["downloads", name] : [name] }).then(([result]): void => {
    if (OnChrome && Build.MinCVer < BrowserVer.MinCorrectExtPermissionsOnChromeURL$NewTabPage
        && CurCVer_ < BrowserVer.MinCorrectExtPermissionsOnChromeURL$NewTabPage
        && name === "chrome://new-tab-page/*") {
      result = false
    }
    const val = result ? item.name_ !== kCrURL || <boolean> bgSettings_.get_("allBrowserUrls") ? 2 : 1 : 0
    item.previous_ = val
    resolve()
  })
  return p
}

const onChange = (e: Event): void => {
  const el = e.target as HTMLInputElement
  const item = shownItems.find(i => i.element_ === el)
  if (!item) { return }
  const value = el.checked
  if (OnChrome && (item.name_ === kCrURL || item.name_ === kNTP)) {
    const isCurNTP = item.name_ === kNTP, theOtherName = isCurNTP ? kCrURL : kNTP
    const theOther = shownItems.find(i => i.name_ === theOtherName)
    if (theOther) {
      if (isCurNTP && value && !theOther.element_.checked) {
        theOther.element_.checked = theOther.element_.indeterminate = true
      } else if (!isCurNTP && value && el.indeterminate) {
        el.indeterminate = false
      } else {
        theOther.element_.checked = value
        theOther.element_.indeterminate = false
      }
    }
  }
}

if (!OnEdge) {
  const ignored: Array<kPermissions | RegExpOne> = OnFirefox ? [kShelf] : ["downloads"]
  OnChrome || ignored.push(<RegExpOne> /^chrome:/, "contentSettings")
  OnChrome && !IsEdg_ || ignored.push(kNTP)
  OnFirefox || ignored.push("cookies")
  optional_permissions = optional_permissions.filter(
      i => !ignored.some(j => typeof j === "string" ? i === j : j.test(i)))
}
if (OnEdge || !optional_permissions.length) {
  nextTick_((): void => { $("#optionalPermissionsBox").style.display = "none" })
} else {
  for (const name of optional_permissions) {
    shownItems.push({ name_: name, previous_: 0, element_: null as never })
  }
  nextTick_(initOptionalPermissions)
  void Promise.all(shownItems.map(doPermissionsContain_)).then((): void => {
    nextTick_((): void => {
      (container.dataset as KnownOptionsDataset).model = "OptionalPermissions"
      void createNewOption(container).fetch_()
    })
  })
}
