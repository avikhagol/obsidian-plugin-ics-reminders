#!/usr/bin/python3
"""Adds, updates and removes events in Evolution Data Server (EDS).
EDS is what the Cinnamon panel calendar, GNOME Calendar and Evolution all read.

stdin (JSON): {"calendar": "Personal", "upsert": [{"uid": "...", "ics": "BEGIN:VEVENT..."}], "delete": ["uid"]}
An empty "calendar" means your default calendar. stdout: JSON with the calendar used.
Run with --list to print the calendar names.
"""
import json
import sys

import gi

gi.require_version("EDataServer", "1.2")
gi.require_version("ECal", "2.0")
gi.require_version("ICalGLib", "3.0")
from gi.repository import ECal, EDataServer, GLib, ICalGLib

registry = EDataServer.SourceRegistry.new_sync(None)
sources = registry.list_sources(EDataServer.SOURCE_EXTENSION_CALENDAR)

if "--list" in sys.argv:
    print("\n".join(s.get_display_name() for s in sources))
    sys.exit(0)

req = json.load(sys.stdin)
name = req.get("calendar", "")
source = next((s for s in sources if name and s.get_display_name() == name), None)
if name and source is None:
    sys.exit(f"Calendar '{name}' not found. Available: " + ", ".join(s.get_display_name() for s in sources))
source = source or registry.ref_default_calendar()

client = ECal.Client.connect_sync(source, ECal.ClientSourceType.EVENTS, 5, None)
NONE = ECal.OperationFlags.NONE

for item in req.get("upsert", []):
    text = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n" + item["ics"] + "\r\nEND:VCALENDAR\r\n"
    event = ICalGLib.Component.new_from_string(text).get_first_component(ICalGLib.ComponentKind.VEVENT_COMPONENT)
    try:
        client.create_object_sync(event, NONE, None)
    except GLib.Error as e:
        if "already exists" not in e.message:
            raise
        try:  # same id = already in the calendar: refresh it, and if that fails keep the existing entry
            client.modify_object_sync(event, ECal.ObjModType.ALL, NONE, None)
        except GLib.Error:
            pass

for uid in req.get("delete", []):
    try:
        client.remove_object_sync(uid, None, ECal.ObjModType.ALL, NONE, None)
    except Exception:
        pass  # already gone

print(json.dumps({"calendar": source.get_display_name()}))
