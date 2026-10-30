import AppKit
import Carbon

/// One system-wide hotkey through Carbon's RegisterEventHotKey (no Accessibility permission needed).
final class HotKey {
    private static var actions: [UInt32: () -> Void] = [:]
    private static var handlerInstalled = false
    private var ref: EventHotKeyRef?
    private let id: UInt32

    /// `keyCode` is a virtual key (kVK_ANSI_I); `modifiers` are Carbon flags (optionKey | cmdKey).
    init?(id: UInt32, keyCode: Int, modifiers: Int, action: @escaping () -> Void) {
        self.id = id
        if !Self.handlerInstalled {
            var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            let status = InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
                var hk = EventHotKeyID()
                GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                  nil, MemoryLayout<EventHotKeyID>.size, nil, &hk)
                DispatchQueue.main.async { HotKey.actions[hk.id]?() }
                return noErr
            }, 1, &spec, nil, nil)
            guard status == noErr else { return nil }
            Self.handlerInstalled = true
        }
        let hotKeyID = EventHotKeyID(signature: OSType(0x5452_4B52), id: id) // 'TRKR'
        guard RegisterEventHotKey(UInt32(keyCode), UInt32(modifiers), hotKeyID, GetApplicationEventTarget(), 0, &ref) == noErr
        else { return nil }
        Self.actions[id] = action
    }

    deinit {
        if let ref { UnregisterEventHotKey(ref) }
        Self.actions[id] = nil
    }
}

/// The hotkey choices offered in Settings (a full key recorder is out of scope).
struct HotKeyPreset {
    let id: String
    let keyCode: Int
    let modifiers: Int
    /// For menus: key equivalent and its modifier mask.
    let key: String
    let menuModifiers: NSEvent.ModifierFlags
    let label: String

    static let openWindow: [HotKeyPreset] = [
        HotKeyPreset(id: "optCmdI", keyCode: kVK_ANSI_I, modifiers: optionKey | cmdKey, key: "i", menuModifiers: [.option, .command], label: "⌥⌘I"),
        HotKeyPreset(id: "ctrlOptCmdI", keyCode: kVK_ANSI_I, modifiers: controlKey | optionKey | cmdKey, key: "i", menuModifiers: [.control, .option, .command], label: "⌃⌥⌘I"),
        HotKeyPreset(id: "optCmdT", keyCode: kVK_ANSI_T, modifiers: optionKey | cmdKey, key: "t", menuModifiers: [.option, .command], label: "⌥⌘T"),
    ]
    static let quickCapture: [HotKeyPreset] = [
        HotKeyPreset(id: "optCmdN", keyCode: kVK_ANSI_N, modifiers: optionKey | cmdKey, key: "n", menuModifiers: [.option, .command], label: "⌥⌘N"),
        HotKeyPreset(id: "ctrlOptCmdN", keyCode: kVK_ANSI_N, modifiers: controlKey | optionKey | cmdKey, key: "n", menuModifiers: [.control, .option, .command], label: "⌃⌥⌘N"),
        HotKeyPreset(id: "optShiftCmdN", keyCode: kVK_ANSI_N, modifiers: optionKey | shiftKey | cmdKey, key: "n", menuModifiers: [.option, .shift, .command], label: "⌥⇧⌘N"),
    ]

    static func find(_ id: String?, in list: [HotKeyPreset]) -> HotKeyPreset { list.first { $0.id == id } ?? list[0] }
}
