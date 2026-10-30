import Foundation

/// Line-at-a-time Server-Sent Events parser: returns the payload when a blank line ends an event.
public struct SSEParser {
    private var data: [String] = []
    public init() {}

    public mutating func feed(line raw: String) -> String? {
        let line = raw.hasSuffix("\r") ? String(raw.dropLast()) : raw
        if line.isEmpty {
            defer { data = [] }
            return data.isEmpty ? nil : data.joined(separator: "\n")
        }
        if line.hasPrefix(":") { return nil } // comment / heartbeat
        if line.hasPrefix("data:") {
            var v = line.dropFirst(5)
            if v.first == " " { v = v.dropFirst() }
            data.append(String(v))
        }
        return nil
    }
}
