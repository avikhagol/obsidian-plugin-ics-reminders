# ICS Reminders (Obsidian plugin)

Write reminders in your notes. On every save, the plugin compares them with the previous save and
sends only what changed (new, edited, deleted) to your system calendar, the one the Linux Mint /
Cinnamon panel clock, GNOME Calendar and Evolution read (Evolution Data Server).

## Install
1. One-time, in a terminal:
       sudo apt install evolution-data-server gir1.2-ecal-2.0 gir1.2-edataserver-1.2 python3-gi
2. Copy this folder to `<your vault>/.obsidian/plugins/ics-reminders/` and enable it
   (Settings > Community plugins). Use the .deb or AppImage Obsidian: the Flatpak/Snap versions
   cannot run the system Python.
3. Settings > ICS Reminders > "Test": it should list your calendars.

## Reminder syntax
    - [ ] Call supervisor (@2026-11-05 14:00)
    - [ ] Submit report (@2026-11-07)              <- default time (09:00)
    @2026-11-05 14:00 Call supervisor
    - [ ] Weekly meeting (@2026-11-09 10:00 🔁every monday)

Repeats: `every day`, `every weekday`, `every monday` (any weekday), `every 2 weeks`, `every month`, `every year`.
Typing `@` at the start of a line, or `(@` in a checklist item, opens a date/time picker.
Ticking an item (`- [x]`) or deleting the line removes it from the calendar. One-off reminders
whose time has already passed are not sent.

## How the diff works
Every reminder keeps a stable id. On each save the plugin first matches reminders by identical text,
then by same note and line number, so editing a reminder's time or text updates the same calendar
entry in place (no duplicate). Moving lines around changes nothing. Only new, edited and deleted
reminders are sent; a save that changes none sends nothing. Command "Sync reminders now (full re-send)"
forces everything again.

## Notifications (all optional, in settings)
- Calendar alarms: each event has an alarm N minutes before. Popups come from the calendar side
  (evolution-alarm-notify, installed with evolution-data-server).
- Desktop notifications (notify-send): scheduled with `systemd-run --user` timers. These work even
  if Obsidian is closed afterwards, but systemd forgets them on reboot, so they are re-created
  when Obsidian starts. "every 2 weeks"-style repeats are not supported here.
- Popups inside Obsidian: sticky notice when a reminder is due (Obsidian must be open).
- Optional: also write an .ics file (for apps that can only subscribe to a file, like Thunderbird).

Times are your local time; events carry your system timezone, so repeats stay right across daylight saving.
