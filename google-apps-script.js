/**
 * Shift Coverage App — Google Apps Script
 *
 * Deploy as a Web App:
 *   1. Create a new Google Sheet with these tabs:
 *        • Shifts   — Headers: ID | PostedBy | ShiftDate | StartTime | EndTime | Location | Notes | Status | ClaimedBy | PostedAt | ClaimedAt
 *        • History  — Headers: ID | PostedBy | CoveredBy | ShiftDate | CompletedAt
 *        • Staff    — Headers: Name | Score | IsAdmin
 *        • Config   — Headers: Key | Value
 *   2. In the Staff tab, add your staff names (one per row) with Score = 0.
 *      Mark your admin row with IsAdmin = TRUE.
 *   3. In the Config tab, add a row: AdminPIN | 1234 (or your chosen PIN).
 *   4. Open Extensions > Apps Script and paste this code.
 *   5. Deploy > New deployment > Web app
 *      - Execute as: Me
 *      - Who has access: Anyone
 *   6. Copy the Web App URL and paste it into the app on first use.
 */

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
      return jsonResponse({ status: 'ok', message: 'Shift Coverage script is active.' });
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
      var schedule = sheetToObjects(getSheet('Schedule'));
      // Group by day, preserving row order
      var dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
      var grouped = {};
      dayOrder.forEach(function(d) { grouped[d] = []; });
      schedule.forEach(function(row) {
        var day = String(row.Day).trim();
        if (grouped[day]) {
          grouped[day].push({
            time: String(row.Time).trim(),
            location: String(row.Location).trim(),
            staff: String(row.Staff).trim()
          });
        }
      });
      var result = dayOrder.map(function(day) {
        return { day: day, shifts: grouped[day] };
      });
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

      // Update scores
      updateScore(data.claimedBy, 1);  // coverer gets +1
      updateScore(postedBy, -1);       // poster gets -1

      // Log to history
      var historySheet = getSheet('History');
      historySheet.appendRow([
        data.id,
        postedBy,
        data.claimedBy,
        shiftDate,
        new Date().toISOString()
      ]);

      return jsonResponse({ status: 'ok' });
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

      // If it was claimed, reverse the scores
      var status = sheet.getRange(row, 8).getValue();
      if (status === 'claimed') {
        var postedBy = sheet.getRange(row, 2).getValue();
        var claimedBy = sheet.getRange(row, 9).getValue();
        updateScore(claimedBy, -1);
        updateScore(postedBy, 1);
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
