-- bounce-wet-stems.applescript — drive Logic Pro's "Export All Tracks as Audio Files".
--
-- Called by bounce-wet-stems.sh as:
--   osascript bounce-wet-stems.applescript <projectPath> <destDir> <format> <bitDepth>
--
-- This is BEST-EFFORT GUI scripting. Logic's export sheet differs across versions, so the
-- format/bit-depth popups may need per-version tweaks (see trySetPopup). If anything can't
-- be found it errors out with the dialog left open, so you can finish by hand — the wrapper
-- prints the destination and settings to use. Requires Accessibility permission.

on run argv
	if (count of argv) < 4 then error "usage: <project> <destDir> <format> <bitDepth>"
	set projectPath to item 1 of argv
	set destDir to item 2 of argv
	set fmt to item 3 of argv
	set bitDepth to item 4 of argv

	tell application "Logic Pro"
		activate
		open (POSIX file projectPath)
	end tell

	if not my waitForWindow(60) then error "Logic Pro did not open the project in time."
	delay 1

	tell application "System Events"
		tell process "Logic Pro"
			set frontmost to true
			delay 1

			-- File ▸ Export ▸ All Tracks as Audio Files…
			set exportItem to my findExportItem()
			if exportItem is missing value then error "Menu item 'All Tracks as Audio Files…' not found."
			click exportItem
			delay 2

			-- Point the export at destDir via the standard "Go to Folder" shortcut.
			keystroke "g" using {command down, shift down}
			delay 1
			keystroke destDir
			delay 0.5
			key code 36 -- Return: accept the path
			delay 1

			-- Best-effort format / bit-depth (version dependent; safe no-op if not found).
			my trySetPopup(fmt, bitDepth)

			-- Confirm. The primary button is usually "Export" or "Save".
			if not my clickButtonNamed({"Export", "Save", "OK"}) then
				key code 36 -- fall back to the default button
			end if
		end tell
	end tell

	delay 3 -- allow rendering to start; the wrapper re-checks the destination folder
	return "ok"
end run

-- Wait until Logic has at least one window (the project loaded).
on waitForWindow(timeoutSec)
	repeat with i from 1 to timeoutSec
		try
			tell application "System Events" to tell process "Logic Pro"
				if (count of windows) > 0 then return true
			end tell
		end try
		delay 1
	end repeat
	return false
end waitForWindow

-- Find the "All Tracks as Audio Files…" item under File ▸ Export (prefix match tolerates
-- the trailing ellipsis and minor label changes).
on findExportItem()
	tell application "System Events" to tell process "Logic Pro"
		try
			set fileMenu to menu 1 of menu bar item "File" of menu bar 1
			set exportSub to menu 1 of (menu item "Export" of fileMenu)
			repeat with mi in menu items of exportSub
				if (name of mi) starts with "All Tracks as Audio Files" then return mi
			end repeat
		end try
		return missing value
	end tell
end findExportItem

-- Try to set a pop-up button whose current value we can match. Wrapped so failure is
-- non-fatal — many Logic versions default sensibly and you can adjust by hand if needed.
on trySetPopup(fmt, bitDepth)
	tell application "System Events" to tell process "Logic Pro"
		try
			set theSheet to my frontSheet()
			if theSheet is missing value then return
			set fmtLabel to my formatLabel(fmt)
			repeat with pb in (pop up buttons of theSheet)
				try
					click pb
					delay 0.3
					if (exists (menu item fmtLabel of menu 1 of pb)) then
						click menu item fmtLabel of menu 1 of pb
					else
						key code 53 -- Escape: leave this popup unchanged
					end if
				end try
			end repeat
		end try
	end tell
end trySetPopup

on formatLabel(fmt)
	if fmt is "aiff" then return "AIFF"
	if fmt is "caf" then return "CAF"
	return "WAVE (Broadcast)"
end formatLabel

on frontSheet()
	tell application "System Events" to tell process "Logic Pro"
		try
			return sheet 1 of front window
		on error
			return front window
		end try
	end tell
end frontSheet

on clickButtonNamed(names)
	tell application "System Events" to tell process "Logic Pro"
		set target to my frontSheet()
		if target is missing value then return false
		repeat with n in names
			try
				click (first button of target whose name is n)
				return true
			end try
		end repeat
		return false
	end tell
end clickButtonNamed
