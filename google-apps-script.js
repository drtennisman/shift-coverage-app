/**
 * Shift Coverage App — Google Apps Script
 *
 * Deploy as a Web App:
 *   1. Create a new Google Sheet with these tabs:
 *        • Shifts   — Headers: ID | PostedBy | ShiftDate | StartTime | EndTime | Location | Notes | Status | ClaimedBy | PostedAt | ClaimedAt
 *        • History  — Headers: ID | PostedBy | CoveredBy | ShiftDate | CompletedAt
 *        • Staff    — Headers: Name | Score | IsAdmin | Email
 *        • Config   — Headers: Key | Value
 *        • Schedule — Headers: Day | Time | Location | Staff
 *   2. In the Staff tab, add your staff names (one per row) with Score = 0
 *      and each person's email in the Email column.
 *      Mark your admin row with IsAdmin = TRUE.
 *   3. In the Config tab, add rows:
 *        AdminPIN     | 1234 (or your chosen PIN)
 *        ManagerEmail | manager@example.com (always notified on posts/claims)
 *   4. In the Schedule tab, add the weekly template (Day = "Monday" etc.,
 *      Time = display string like "8:00 AM - 2:00 PM"). Put "Open" in the
 *      Staff column for unfilled shifts staff can claim for +1.
 *   5. Open Extensions > Apps Script and paste this code.
 *   6. Deploy > New deployment > Web app
 *      - Execute as: Me
 *      - Who has access: Anyone
 *   7. To update later: paste new code, then Deploy > Manage deployments >
 *      edit (pencil) > Version: New version > Deploy. Bump VERSION below
 *      so the app can confirm the new code is live.
 */

// ─── Version ────────────────────────────────────────────────
// Bump this with every deploy. The app compares it against its own
// version and warns the admin if the deployed backend is stale.
var VERSION = 10;

// ─── Helpers ────────────────────────────────────────────────

function getSheet(name) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function sheetToObjects(sheet) {
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  var headers = data[0];
  var tz = Session.getScriptTimeZone();
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      var val = data[i][j];
      // Convert Date objects to clean strings so the client gets predictable formats
      if (val instanceof Date) {
        var header = String(headers[j]).trim();
        if (header === 'ShiftDate') {
          val = Utilities.formatDate(val, tz, 'yyyy-MM-dd');
        } else if (header === 'StartTime' || header === 'EndTime' || header === 'Time') {
          val = Utilities.formatDate(val, tz, 'HH:mm');
        } else {
          val = val.toISOString();
        }
      }
      obj[headers[j]] = val;
    }
    rows.push(obj);
  }
  return rows;
}

function findRowByID(sheet, id) {
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      return i + 1; // 1-indexed row number
    }
  }
  return -1;
}

function getAdminPIN() {
  var config = getSheet('Config');
  var data = config.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === 'AdminPIN') return String(data[i][1]);
  }
  return '1234';
}

// ─── Auto-cleanup: expire past open shifts ──────────────────

function expirePastShifts() {
  var sheet = getSheet('Shifts');
  var data = sheet.getDataRange().getValues();
  var now = new Date();
  var todayStr = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd');

  for (var i = 1; i < data.length; i++) {
    var status = data[i][7]; // Status column (H)
    if (status !== 'open') continue;

    var raw = data[i][2]; // ShiftDate column (C)
    var shiftStr;
    if (raw instanceof Date) {
      shiftStr = Utilities.formatDate(raw, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    } else {
      shiftStr = String(raw).substring(0, 10); // handles "2026-04-03" strings
    }

    if (shiftStr < todayStr) {
      sheet.getRange(i + 1, 8).setValue('expired'); // Set Status to expired
    }
  }
}

// ─── GET Endpoints ──────────────────────────────────────────

function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || 'ping';

    if (action === 'ping') {
      return jsonResponse({ status: 'ok', message: 'Shift Coverage script is active.', version: VERSION });
    }

    if (action === 'verifyPin') {
      var valid = String(e.parameter.pin || '') === getAdminPIN();
      return jsonResponse({ status: 'ok', valid: valid });
    }

    if (action === 'getStaff') {
      var staff = sheetToObjects(getSheet('Staff'));
      var names = staff.map(function(s) { return s.Name; }).filter(function(n) { return n; });
      return jsonResponse({ status: 'ok', staff: names });
    }

    if (action === 'getShifts') {
      expirePastShifts();
      var shifts = sheetToObjects(getSheet('Shifts'));
      var open = shifts.filter(function(s) { return s.Status === 'open'; });
      // Sort by date ascending
      open.sort(function(a, b) { return new Date(a.ShiftDate) - new Date(b.ShiftDate); });
      return jsonResponse({ status: 'ok', shifts: open });
    }

    if (action === 'getScores') {
      var staff = sheetToObjects(getSheet('Staff'));
      staff.sort(function(a, b) { return Number(b.Score) - Number(a.Score); });
      var scores = staff.map(function(s) {
        return { name: s.Name, score: Number(s.Score) || 0, isAdmin: s.IsAdmin === true || s.IsAdmin === 'TRUE' };
      });
      return jsonResponse({ status: 'ok', scores: scores });
    }

    if (action === 'getHistory') {
      var history = sheetToObjects(getSheet('History'));
      // Sort newest first
      history.sort(function(a, b) { return new Date(b.CompletedAt) - new Date(a.CompletedAt); });
      // Return last 50
      var recent = history.slice(0, 50).map(function(h) {
        return {
          id: h.ID,
          postedBy: h.PostedBy,
          coveredBy: h.CoveredBy,
          shiftDate: h.ShiftDate,
          completedAt: h.CompletedAt
        };
      });
      return jsonResponse({ status: 'ok', history: recent });
    }

    if (action === 'getSchedule') {
      var tz = Session.getScriptTimeZone();
      var schedule = sheetToObjects(getSheet('Schedule'));
      var shiftsData = sheetToObjects(getSheet('Shifts'));
      var dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

      // Group template shifts by day name
      var templateByDay = {};
      dayNames.forEach(function(d) { templateByDay[d] = []; });
      schedule.forEach(function(row) {
        var day = String(row.Day).trim();
        if (templateByDay[day]) {
          templateByDay[day].push({
            time: String(row.Time).trim(),
            location: String(row.Location).trim(),
            staff: String(row.Staff).trim()
          });
        }
      });

      // Build next 14 days
      var result = [];
      for (var d = 0; d < 14; d++) {
        var date = new Date();
        date.setDate(date.getDate() + d);
        var dateStr = Utilities.formatDate(date, tz, 'yyyy-MM-dd');
        var dayName = dayNames[date.getDay()];
        var templateShifts = templateByDay[dayName] || [];

        // Find posted shifts for this date
        var postedForDate = shiftsData.filter(function(s) {
          var sd = (s.ShiftDate instanceof Date)
            ? Utilities.formatDate(s.ShiftDate, tz, 'yyyy-MM-dd')
            : String(s.ShiftDate).substring(0, 10);
          return sd === dateStr && (s.Status === 'open' || s.Status === 'claimed');
        });

        // Build shifts for this day
        var dayShifts = templateShifts.map(function(tmpl) {
          var isOpen = String(tmpl.staff).trim().toLowerCase() === 'open';

          if (isOpen) {
            // Check if someone already claimed this open shift
            var claimed = null;
            for (var i = 0; i < postedForDate.length; i++) {
              if (postedForDate[i].PostedBy === 'Open' && postedForDate[i].Status === 'claimed') {
                // Match by exact template time (blank never matches, so a
                // claim can't accidentally mark the wrong slot covered)
                var shiftTime = String(postedForDate[i].StartTime).trim();
                if (shiftTime && shiftTime === tmpl.time) {
                  claimed = postedForDate[i];
                  break;
                }
              }
            }

            if (claimed) {
              return {
                time: tmpl.time,
                location: tmpl.location,
                staff: String(claimed.ClaimedBy),
                originalStaff: 'Open',
                status: 'covered'
              };
            } else {
              return {
                time: tmpl.time,
                location: tmpl.location,
                staff: 'Open',
                date: dateStr,
                status: 'open_shift'
              };
            }
          }

          // Regular staff — check if they posted a shift for this date
          var match = null;
          for (var i = 0; i < postedForDate.length; i++) {
            if (postedForDate[i].PostedBy === tmpl.staff) {
              match = postedForDate[i];
              break;
            }
          }

          if (match && match.Status === 'open') {
            return {
              time: tmpl.time,
              location: tmpl.location,
              staff: tmpl.staff,
              status: 'needs_coverage'
            };
          } else if (match && match.Status === 'claimed') {
            return {
              time: tmpl.time,
              location: tmpl.location,
              staff: String(match.ClaimedBy),
              originalStaff: tmpl.staff,
              status: 'covered'
            };
          } else {
            return {
              time: tmpl.time,
              location: tmpl.location,
              staff: tmpl.staff,
              status: 'normal'
            };
          }
        });

        result.push({
          day: dayName,
          date: dateStr,
          isToday: d === 0,
          shifts: dayShifts
        });
      }

      return jsonResponse({ status: 'ok', schedule: result });
    }

    if (action === 'getAllShifts') {
      // Admin: get all shifts (including claimed/expired)
      var shifts = sheetToObjects(getSheet('Shifts'));
      shifts.sort(function(a, b) { return new Date(b.PostedAt) - new Date(a.PostedAt); });
      return jsonResponse({ status: 'ok', shifts: shifts });
    }

    return jsonResponse({ status: 'error', message: 'Unknown action: ' + action });

  } catch (err) {
    return jsonResponse({ status: 'error', message: err.toString() });
  }
}

// ─── POST Endpoints ─────────────────────────────────────────

function doPost(e) {
  // Serialize all writes so two people acting at once can't corrupt
  // scores or double-claim a shift (read-modify-write on the Sheet).
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (lockErr) {
    return jsonResponse({ status: 'error', message: 'Server busy — please try again.' });
  }
  try {
    var data = JSON.parse(e.postData.contents);
    var action = data.action;

    // ── Post a new shift ──
    if (action === 'postShift') {
      var sheet = getSheet('Shifts');
      var id = String(Date.now());
      sheet.appendRow([
        id,
        data.postedBy,
        data.shiftDate,
        data.startTime,
        data.endTime,
        data.location || '',
        data.notes || '',
        'open',
        '',
        new Date().toISOString(),
        ''
      ]);
      // Poster gets -1 immediately for needing coverage
      updateScore(data.postedBy, -1);
      // Notify all other staff that a shift needs coverage
      notifyAllStaff_ShiftPosted(data.postedBy, data.shiftDate, data.startTime, data.endTime, data.location || '');
      return jsonResponse({ status: 'ok', id: id });
    }

    // ── Claim a shift ──
    if (action === 'claimShift') {
      var sheet = getSheet('Shifts');
      var row = findRowByID(sheet, data.id);
      if (row === -1) return jsonResponse({ status: 'error', message: 'Shift not found.' });

      var currentStatus = sheet.getRange(row, 8).getValue();
      if (currentStatus !== 'open') {
        return jsonResponse({ status: 'error', message: 'Shift is no longer open.' });
      }

      var postedBy = sheet.getRange(row, 2).getValue();
      var shiftDate = sheet.getRange(row, 3).getValue();

      // Update shift
      sheet.getRange(row, 8).setValue('claimed');    // Status
      sheet.getRange(row, 9).setValue(data.claimedBy); // ClaimedBy
      sheet.getRange(row, 11).setValue(new Date().toISOString()); // ClaimedAt

      // Coverer gets +1 (poster already got -1 when they posted)
      updateScore(data.claimedBy, 1);

      // Log to history — but not self-covers ("I'll Work It"), which
      // would read as "X covered X's shift" and just net out to zero
      var isSelfCover = String(postedBy) === String(data.claimedBy);
      if (!isSelfCover) {
        var historySheet = getSheet('History');
        historySheet.appendRow([
          data.id,
          postedBy,
          data.claimedBy,
          shiftDate,
          new Date().toISOString()
        ]);
      }

      // Notify the poster that their shift has been covered (skip self-covers)
      if (!isSelfCover) {
        var startTime = sheet.getRange(row, 4).getValue();
        var endTime = sheet.getRange(row, 5).getValue();
        var tz = Session.getScriptTimeZone();
        var startStr = (startTime instanceof Date) ? Utilities.formatDate(startTime, tz, 'HH:mm') : String(startTime);
        var endStr = (endTime instanceof Date) ? Utilities.formatDate(endTime, tz, 'HH:mm') : String(endTime);
        notifyPoster_ShiftClaimed(postedBy, data.claimedBy, shiftDate, startStr, endStr);
      }

      return jsonResponse({ status: 'ok' });
    }

    // ── Claim an open (unfilled) shift from the schedule ──
    if (action === 'claimOpenShift') {
      var sheet = getSheet('Shifts');
      var id = String(Date.now());
      sheet.appendRow([
        id,
        'Open',
        data.shiftDate,
        // Store the schedule template's display time so getSchedule can
        // match this claim back to the exact open slot it came from.
        data.time || '',
        '',
        data.location || '',
        '',
        'claimed',
        data.claimedBy,
        new Date().toISOString(),
        new Date().toISOString()
      ]);

      // Claimer gets +1, nobody gets -1
      updateScore(data.claimedBy, 1);

      // Log to history
      var historySheet = getSheet('History');
      historySheet.appendRow([
        id,
        'Open',
        data.claimedBy,
        data.shiftDate,
        new Date().toISOString()
      ]);

      // Notify manager
      try {
        var managerEmail = getManagerEmail();
        if (managerEmail) {
          var dateStr = formatDateForEmail(data.shiftDate);
          var subject = 'Open Shift Claimed - ' + data.claimedBy + ' on ' + dateStr;
          var body = data.claimedBy + ' picked up an open shift:\n\n'
            + 'Date: ' + dateStr + '\n'
            + 'Time: ' + (data.time || '') + '\n'
            + 'Location: ' + (data.location || '') + '\n\n'
            + 'Score: +1 for ' + data.claimedBy;
          MailApp.sendEmail({ to: managerEmail, subject: subject, body: body });
        }
      } catch (e) {}

      return jsonResponse({ status: 'ok', id: id });
    }

    // ── Cancel own shift (before claimed) ──
    if (action === 'cancelShift') {
      var sheet = getSheet('Shifts');
      var row = findRowByID(sheet, data.id);
      if (row === -1) return jsonResponse({ status: 'error', message: 'Shift not found.' });

      var currentStatus = sheet.getRange(row, 8).getValue();
      if (currentStatus !== 'open') {
        return jsonResponse({ status: 'error', message: 'Can only cancel open shifts.' });
      }

      // Reverse the poster's -1 since they're taking it back
      var postedBy = sheet.getRange(row, 2).getValue();
      updateScore(postedBy, 1);

      sheet.deleteRow(row);
      return jsonResponse({ status: 'ok' });
    }

    // ── Admin: Delete a shift ──
    if (action === 'deleteShift') {
      if (String(data.pin) !== getAdminPIN()) {
        return jsonResponse({ status: 'error', message: 'Invalid admin PIN.' });
      }

      var sheet = getSheet('Shifts');
      var row = findRowByID(sheet, data.id);
      if (row === -1) return jsonResponse({ status: 'error', message: 'Shift not found.' });

      // Reverse all scores for this shift
      var status = sheet.getRange(row, 8).getValue();
      var postedBy = sheet.getRange(row, 2).getValue();
      if (status === 'open') {
        // Poster had -1, reverse it
        updateScore(postedBy, 1);
      } else if (status === 'claimed') {
        // Poster had -1, claimer had +1, reverse both
        var claimedBy = sheet.getRange(row, 9).getValue();
        updateScore(postedBy, 1);
        updateScore(claimedBy, -1);
      }

      sheet.deleteRow(row);
      return jsonResponse({ status: 'ok' });
    }

    // ── Admin: Reset all scores ──
    if (action === 'resetScores') {
      if (String(data.pin) !== getAdminPIN()) {
        return jsonResponse({ status: 'error', message: 'Invalid admin PIN.' });
      }

      var staffSheet = getSheet('Staff');
      var lastRow = staffSheet.getLastRow();
      if (lastRow > 1) {
        for (var i = 2; i <= lastRow; i++) {
          staffSheet.getRange(i, 2).setValue(0);
        }
      }
      return jsonResponse({ status: 'ok' });
    }

    // ── Admin: Add staff ──
    if (action === 'addStaff') {
      if (String(data.pin) !== getAdminPIN()) {
        return jsonResponse({ status: 'error', message: 'Invalid admin PIN.' });
      }

      var staffSheet = getSheet('Staff');
      staffSheet.appendRow([data.name, 0, false]);
      return jsonResponse({ status: 'ok' });
    }

    // ── Admin: Remove staff ──
    if (action === 'removeStaff') {
      if (String(data.pin) !== getAdminPIN()) {
        return jsonResponse({ status: 'error', message: 'Invalid admin PIN.' });
      }

      var staffSheet = getSheet('Staff');
      var staffData = staffSheet.getDataRange().getValues();
      for (var i = 1; i < staffData.length; i++) {
        if (staffData[i][0] === data.name) {
          staffSheet.deleteRow(i + 1);
          break;
        }
      }
      return jsonResponse({ status: 'ok' });
    }

    return jsonResponse({ status: 'error', message: 'Unknown action: ' + action });

  } catch (err) {
    return jsonResponse({ status: 'error', message: err.toString() });
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

// ─── Score Helper ───────────────────────────────────────────

function updateScore(name, delta) {
  var staffSheet = getSheet('Staff');
  var data = staffSheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === name) {
      var current = Number(data[i][1]) || 0;
      staffSheet.getRange(i + 1, 2).setValue(current + delta);
      return;
    }
  }
}

// ─── Email Helpers ─────────────────────────────────────────

function getManagerEmail() {
  var config = getSheet('Config');
  var data = config.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === 'ManagerEmail') return String(data[i][1]).trim();
  }
  return '';
}

function getStaffEmails() {
  var staffSheet = getSheet('Staff');
  var data = staffSheet.getDataRange().getValues();
  var headers = data[0];
  var emailCol = -1;
  for (var j = 0; j < headers.length; j++) {
    if (String(headers[j]).trim().toLowerCase() === 'email') {
      emailCol = j;
      break;
    }
  }
  if (emailCol === -1) return {};
  var emails = {};
  for (var i = 1; i < data.length; i++) {
    var name = data[i][0];
    var email = data[i][emailCol];
    if (name && email) emails[name] = String(email).trim();
  }
  return emails;
}

function formatTimeForEmail(timeStr) {
  if (!timeStr) return '';
  var parts = String(timeStr).split(':');
  var h = parseInt(parts[0]);
  var m = parts[1];
  var ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return h + ':' + m + ' ' + ampm;
}

function formatDateForEmail(dateInput) {
  if (!dateInput) return '';
  var d;
  if (dateInput instanceof Date) {
    d = dateInput;
  } else {
    d = new Date(String(dateInput).substring(0, 10) + 'T12:00:00');
  }
  if (isNaN(d.getTime())) return String(dateInput);
  var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return days[d.getDay()] + ', ' + months[d.getMonth()] + ' ' + d.getDate();
}

function notifyAllStaff_ShiftPosted(postedBy, shiftDate, startTime, endTime, location) {
  try {
    var emails = getStaffEmails();
    var dateStr = formatDateForEmail(shiftDate);
    var timeStr = formatTimeForEmail(startTime) + ' - ' + formatTimeForEmail(endTime);
    var locationStr = location ? ' at ' + location : '';
    var subject = 'Shift Coverage Needed - ' + postedBy + ' on ' + dateStr;
    var body = postedBy + ' needs someone to cover their shift:\n\n'
      + 'Date: ' + dateStr + '\n'
      + 'Time: ' + timeStr + locationStr + '\n\n'
      + 'Open the Shift Coverage app to claim it:\n'
      + 'https://drtennisman.github.io/shift-coverage-app/';

    var recipients = [];
    for (var name in emails) {
      if (name !== postedBy && emails[name]) {
        recipients.push(emails[name]);
      }
    }
    // Always include manager
    var managerEmail = getManagerEmail();
    if (managerEmail && recipients.indexOf(managerEmail) === -1) {
      recipients.push(managerEmail);
    }
    if (recipients.length > 0) {
      MailApp.sendEmail({
        to: recipients.join(','),
        subject: subject,
        body: body
      });
    }
  } catch (e) {
    // Don't fail the main action if email fails
  }
}

function notifyPoster_ShiftClaimed(postedBy, claimedBy, shiftDate, startTime, endTime) {
  try {
    var emails = getStaffEmails();
    var posterEmail = emails[postedBy];
    var managerEmail = getManagerEmail();

    var dateStr = formatDateForEmail(shiftDate);
    var timeStr = formatTimeForEmail(startTime) + ' - ' + formatTimeForEmail(endTime);
    var subject = 'Shift Covered! - ' + claimedBy + ' covering ' + postedBy + ' on ' + dateStr;
    var body = claimedBy + ' is covering ' + postedBy + '\'s shift:\n\n'
      + 'Date: ' + dateStr + '\n'
      + 'Time: ' + timeStr + '\n\n'
      + 'This shift is all set!';

    var recipients = [];
    if (posterEmail) recipients.push(posterEmail);
    if (managerEmail && recipients.indexOf(managerEmail) === -1) {
      recipients.push(managerEmail);
    }
    if (recipients.length > 0) {
      MailApp.sendEmail({
        to: recipients.join(','),
        subject: subject,
        body: body
      });
    }
  } catch (e) {
    // Don't fail the main action if email fails
  }
}
