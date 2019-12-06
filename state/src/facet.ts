import {Transaction} from "./transaction"
import {EditorSelection} from "./selection"
import {EditorState} from "./state"
import {Text} from "../../text"

let nextID = 0

const none: readonly any[] = []

export class Facet<Input, Output> {
  /// @internal
  readonly id = nextID++
  /// @internal
  readonly default: Output

  private constructor(
    /// @internal
    readonly combine: (values: readonly Input[]) => Output,
    /// @internal
    readonly compare: (a: Output, b: Output) => boolean,
    private isStatic: boolean
  ) {
    this.default = combine([])
  }

  static define<Input, Output = readonly Input[]>(config: {
    combine?: (value: readonly Input[]) => Output,
    compare?: (a: Output, b: Output) => boolean,
    static?: boolean
  } = {}) {
    return new Facet<Input, Output>(config.combine || ((a: any) => a) as any,
                                    config.compare || (!config.combine ? sameArray as any : (a, b) => a === b),
                                    !!config.static)
  }

  of(value: Input): Extension {
    return new FacetProvider<Input>(none, this, (_, output) => output.push(value))
  }

  derive<Deps extends {[name: string]: Slot<any>}>(
    deps: Deps,
    get: (deps: DepMap<Deps>) => Input
  ): Extension {
    if (this.isStatic) throw new Error("Can't derive a static facet")
    let map = depMap(deps)
    return new FacetProvider<Input>(depList(deps), this, (values, output) => {
      map._values = values
      output.push(get(map))
    })
  }

  deriveN<Deps extends {[name: string]: Slot<any>}>(
    deps: Deps,
    get: (deps: DepMap<Deps>) => readonly Input[]
  ) {
    if (this.isStatic) throw new Error("Can't derive a static facet")
    let map = depMap(deps)
    return new FacetProvider<Input>(depList(deps), this, (values, output) => {
      map._values = values
      for (let v of get(map)) output.push(v)
    })
  }
}

function sameArray<T>(a: readonly T[], b: readonly T[]) {
  return a == b || a.length == b.length && a.every((e, i) => e === b[i])
}

type Slot<T> = Facet<any, T> | StateField<T>

declare const isExtension: unique symbol

class FacetProvider<Input> {
  constructor(readonly dependencies: readonly Slot<any>[],
              readonly facet: Facet<Input, any>,
              readonly get: (values: EditorState, gather: Input[]) => void) {}

  [isExtension]!: true
}

export type DepMap<Deps extends {[name: string]: Slot<any>}> = {[id in keyof Deps]: Deps[id] extends Slot<infer T> ? T : never}

function slotGetter(id: number) {
  return function(this: any) { return this._values.get(id) }
}

function slotChanged(id: number) {
  return function(this: any) { return this._values[id].idHasChanged(id) }
}

function depList(deps: {[name: string]: Slot<any>}) {
  let result = []
  for (let name in deps) result.push(deps[name])
  return result
}

function depMap<Deps extends {[name: string]: Slot<any>}>(deps: Deps): any {
  let map: any = Object.create(null)
  for (let name in deps) {
    Object.defineProperty(map, name, {get: slotGetter(deps[name].id)})
    Object.defineProperty(map, name + "_changed", {get: slotChanged(deps[name].id)})
  }
  return map
}

/// Parameters passed when creating a
/// [`StateField`](#state.StateField^define). The `Value` type
/// parameter refers to the content of the field. Since it will be
/// stored in (immutable) state objects, it should be an immutable
/// value itself. The `Deps` type parameter is used only for fields
/// with [dependencies](#state.StateField^defineDeps).
export type StateFieldSpec<Value, Deps> = {
  /// Creates the initial value for the field when a state is created.
  create: (doc: Text, sel: EditorSelection, deps: Deps) => Value,

  /// Compute a new value from the field's previous value and a
  /// [transaction](#state.Transaction).
  update: (value: Value, transaction: Transaction, deps: Deps) => Value,

  /// Compare two values of the field, returning `true` when they are
  /// the same. This is used to avoid recomputing facets that depend
  /// on the field when its value did not change.
  compare?: (a: Value, b: Value) => boolean
}

/// Fields can store additional information in an editor state, and
/// keep it in sync with the rest of the state.
export class StateField<Value> {
  /// @internal
  readonly id = nextID++

  private constructor(
    /// @internal
    readonly dependencies: readonly Slot<any>[],
    private createF: (doc: Text, selection: EditorSelection, values: EditorState) => Value,
    private readonly updateF: (value: Value, tr: Transaction, values: EditorState) => Value,
    private compareF: (a: Value, b: Value) => boolean
  ) {}

  /// Define a state field.
  static define<Value>(config: StateFieldSpec<Value, {}>): StateField<Value> {
    return new StateField<Value>(none, config.create, config.update,
                                 config.compare || ((a, b) => a === b))
  }

  /// Define a state field that depends on other fields or facets.
  /// These must be explicitly defined to make sure that fields and
  /// facets are computed in the correct order.
  static defineDeps<Deps extends {[name: string]: Slot<any>}>(dependencies: Deps) {
    let map = depMap(dependencies)
    return <Value>({create, update, compare}: StateFieldSpec<Value, DepMap<Deps>>) => new StateField<Value>(
      depList(dependencies),
      (doc, sel, values) => { map._values = values; return create(doc, sel, map) },
      (value, tr, values) => { map._values = values; return update(value, tr, map) },
      compare || ((a, b) => a === b)
    )
  }

  /// @internal
  init(values: EditorState, doc: Text, selection: EditorSelection, prev?: EditorState) {
    values.setID(this.id, prev && prev.config.address[this.id] != null ? prev.getID(this.id) : this.createF(doc, selection, values))
  }

  /// @internal
  update(values: EditorState, prev: EditorState, tr: Transaction) {
    let oldVal = prev.getID(this.id), newVal = this.updateF(oldVal, tr, values)
    if (!this.compareF(oldVal, newVal)) values.setID(this.id, newVal)
  }

  [isExtension]!: true
}

export type Extension = {[isExtension]: true} | readonly Extension[]

class FacetInstance<Input> {
  dependencies: readonly Slot<any>[]

  constructor(readonly facet: Facet<Input, any>,
              readonly providers: readonly FacetProvider<Input>[]) {
    let deps = []
    for (let prov of providers) for (let dep of prov.dependencies)
      if (deps.indexOf(dep) < 0) deps.push(dep)
    this.dependencies = deps
  }

  recompute(values: EditorState) {
    let result: Input[] = []
    for (let p of this.providers) p.get(values, result)
    return this.facet.combine(result)
  }

  init(values: EditorState) {
    values.setID(this.id, this.recompute(values))
  }

  update(values: EditorState, prev: EditorState) {
    if (this.dependencies.some(d => values.idHasChanged(d.id))) {
      let newVal = this.recompute(values)
      if (!this.facet.compare(newVal, prev.getID(this.id)))
        values.setID(this.id, newVal)
    }
  }

  get id() { return this.facet.id }
}

type SlotInstance = StateField<any> | FacetInstance<any>

const enum Prec { Override, Extend, Default, Fallback }

export const prec = {
  fallback(e: Extension): Extension { return new PrecExtension(e, Prec.Fallback) },
  default(e: Extension): Extension { return new PrecExtension(e, Prec.Default) },
  extend(e: Extension): Extension { return new PrecExtension(e, Prec.Extend) },
  override(e: Extension): Extension { return new PrecExtension(e, Prec.Override) }
}

class PrecExtension {
  constructor(readonly e: Extension, readonly prec: Prec) {}
  [isExtension]!: true
}

export class Configuration {
  constructor(readonly dynamicSlots: SlotInstance[],
              readonly address: {[id: number]: number},
              readonly staticValues: readonly any[]) {}

  init(doc: Text, selection: EditorSelection, prev?: EditorState): EditorState {
    let values = new EditorState(this, doc, selection, [])
    for (let slot of this.dynamicSlots) slot.init(values, doc, selection, prev)
    return values
  }

  staticFacet<Output>(facet: Facet<any, Output>) {
    let addr = this.address[facet.id]
    return addr == null ? facet.default : this.staticValues[addr >> 1]
  }

  static resolve(extension: Extension) {
    let providers: {[id: number]: FacetProvider<any>[]} = Object.create(null)
    let slots: {[id: number]: {value: Slot<any>, deps: Slot<any>[], mark: number}} = Object.create(null)

    for (let ext of flatten(extension)) {
      if (ext instanceof StateField) {
        slots[ext.id] = {value: ext, deps: ext.dependencies as Slot<any>[], mark: 0}
      } else {
        let slot = slots[ext.facet.id] || (slots[ext.facet.id] = {value: ext.facet, deps: [], mark: 0})
        for (let dep of ext.dependencies) if (slot.deps.indexOf(dep) < 0) slot.deps.push(dep)
        ;(providers[ext.facet.id] || (providers[ext.facet.id] = [])).push(ext)
      }
    }

    let ordered: SlotInstance[] = []
    function visit(slot: {value: Slot<any>, deps: Slot<any>[], mark: number}) {
      if (slot.mark) {
        if (slot.mark == 1) throw new Error("Cyclic dependency in facets and fields")
        return
      }
      slot.mark = 1
      for (let dep of slot.deps) {
        let found = slots[dep.id]
        if (!found) {
          if (dep instanceof StateField) throw new Error("Dependency on unavailable field")
          continue
        }
        visit(found)
      }
      slot.mark = 2
      ordered.push(slot.value instanceof Facet ? new FacetInstance(slot.value, providers[slot.value.id]) : slot.value)
    }
    for (let id in slots) visit(slots[id])

    function isStatic(slot: Slot<any>) {
      return slot instanceof Facet && providers[slot.id].every(prov => prov.dependencies.every(isStatic))
    }
    let address: {[id: number]: number} = Object.create(null), tempAddress: {[id: number]: number} = Object.create(null)
    let staticSlots: FacetInstance<any>[] = []
    let dynamicSlots: SlotInstance[] = []
    for (let slot of ordered) {
      if (slot instanceof FacetInstance && isStatic(slot.facet)) {
        address[slot.facet.id] = 1 | (staticSlots.length << 1)
        tempAddress[slot.facet.id] = staticSlots.length << 1
        staticSlots.push(slot)
      } else {
        address[slot.id] = dynamicSlots.length << 1
        dynamicSlots.push(slot)
      }
    }

    let tempValues = new EditorState(new Configuration(staticSlots, tempAddress, none), Text.empty, EditorSelection.single(0), [])
    for (let slot of staticSlots) slot.init(tempValues)
    return new Configuration(dynamicSlots, address, tempValues.values)
  }
}

function flatten(extension: Extension) {
  let result: (FacetProvider<any> | StateField<any>)[][] = [[], [], [], []]
  ;(function inner(ext, prec: Prec) {
    if (Array.isArray(ext)) for (let e of ext) inner(e, prec)
    else if (ext instanceof PrecExtension) inner(ext.e, ext.prec)
    else result[prec].push(ext as any)
  })(extension, Prec.Default)
  return result.reduce((a, b) => a.concat(b))
}