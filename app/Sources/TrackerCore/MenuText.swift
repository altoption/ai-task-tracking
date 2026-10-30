import Foundation

public enum MenuText {
    /// "Q-123  Fix the importer…  — Needs review" with the title cut to `max` characters.
    public static func needsYouItem(id: String, title: String, why: String, max: Int = 48) -> String {
        let t = title.count > max ? String(title.prefix(max - 1)).trimmingCharacters(in: .whitespaces) + "…" : title
        return "\(id)  \(t)  — \(why)"
    }

    /// The menu's why for a Needs-you row: "Waiting", "stalled: idle 31 h in In Progress", "Waiting · stalled: …".
    public static func needsYouWhy(why: String, stalled: String?) -> String {
        guard let stalled, !stalled.isEmpty else { return why }
        return why == "stalled" || why.isEmpty ? "stalled: \(stalled)" : "\(why) · stalled: \(stalled)"
    }

    /// "Task, Bug ,, x" → ["Task", "Bug", "x"].
    public static func labels(_ text: String) -> [String] {
        text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
}
