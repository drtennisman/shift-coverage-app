/**
 * Shift Coverage App -- Google Apps Script
 *
 * Deploy as a Web App:
 *   1. Create a new Google Sheet with these tabs:
 *        - Shifts   -- Headers: ID | PostedBy | ShiftDate | StartTime | EndTime | Location | Notes | Status | ClaimedBy | PostedAt | ClaimedAt
 *        - History  -- Headers: ID | PostedBy | CoveredBy | ShiftDate | CompletedAt
 *        - Staff    -- Headers: Name | Score | IsAdmin | Email
 *        - Config   -- Headers: Key | Value
 *        - Schedule -- Headers: Day | Time | Location | Staff
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

// --- Version ------------------------------------------------
// Bump this with every deploy. The app compares it against its own
// version and warns the admin if the deployed backend is stale.
var VERSION = 18;

// --- Helpers ------------------------------------------------

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

// --- Auto-cleanup: expire past open shifts ------------------

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

// --- GET Endpoints ------------------------------------------

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

      // Follow a coverage chain for one date: the scheduled person may have
      // posted their shift, the claimer may have re-posted it, and so on.
      // Returns who currently holds the shift, and their open post if they
      // are looking for coverage. `visited` prevents loops (e.g. self-covers).
      // tmplTime ("8:00 AM - 3:00 PM") keeps a post on the shift it belongs to:
      // someone with two shifts that day (Carson works 8:30-1 and 1-6 on
      // Saturdays) posting one of them must not mark both. A post only joins
      // a shift whose hours it overlaps. Partial posts (8-10 of an 8-3 shift)
      // still overlap, and a post with unreadable times matches as before.
      function followChain(posted, startName, visited, tmplTime) {
        var current = startName;
        var openPost = null;
        var span = clockSpan_(tmplTime, '');
        var lastPost = null, notNeeded = null;
        for (var hop = 0; hop < 10; hop++) {
          var next = null;
          for (var i = 0; i < posted.length; i++) {
            var p = posted[i];
            if (visited[p.ID]) continue;
            if (p.PostedBy !== current) continue;
            if (span) {
              var ps = clockSpan_(p.StartTime, p.EndTime);
              if (ps && Math.min(ps.end, span.end) - Math.max(ps.start, span.start) <= 0) continue;
            }
            next = p;
            break;
          }
          if (!next) break;
          visited[next.ID] = true;
          if (next.Status === 'not_needed') { notNeeded = next; break; }
          lastPost = next;
          if (next.Status === 'open') { openPost = next; break; }
          current = String(next.ClaimedBy);
        }
        return { staff: current, openPost: openPost, lastPost: lastPost, notNeeded: notNeeded };
      }

      // Adds the posted hours (when they differ from the regular shift) and
      // the post's ID and poster, so the app can offer Edit hours / Undo.
      function withPost(out, post, tmplTime) {
        if (!post) return out;
        out.postId = String(post.ID);
        out.postedBy = String(post.PostedBy);
        var ps = clockSpan_(post.StartTime, post.EndTime), ts = clockSpan_(tmplTime, '');
        if (ps) {
          out.postStart = minutesTo24h_(ps.start);
          out.postEnd = minutesTo24h_(ps.end);
          if (!ts || ps.start !== ts.start || ps.end !== ts.end) out.postedTime = minutesToLabel12_(ps.start) + ' \u2013 ' + minutesToLabel12_(ps.end);
        }
        return out;
      }

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
          return sd === dateStr && (s.Status === 'open' || s.Status === 'claimed' || s.Status === 'not_needed');
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
              // Follow the chain past the claimer -- they may have re-posted
              var visited = {};
              visited[claimed.ID] = true;
              var res = followChain(postedForDate, String(claimed.ClaimedBy), visited, tmpl.time);
              if (res.notNeeded) {
                return withPost({ time: tmpl.time, location: tmpl.location, staff: res.staff,
                                  originalStaff: 'Open', status: 'not_needed' }, res.notNeeded, tmpl.time);
              }
              return withPost({
                time: tmpl.time,
                location: tmpl.location,
                staff: res.staff,
                originalStaff: 'Open',
                status: res.openPost ? 'needs_coverage' : 'covered'
              }, res.openPost || res.lastPost || claimed, tmpl.time);
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

          // Regular staff -- follow the full coverage chain for this date
          var res = followChain(postedForDate, tmpl.staff, {}, tmpl.time);

          if (res.notNeeded) {
            var nn = { time: tmpl.time, location: tmpl.location, staff: res.staff, status: 'not_needed' };
            if (res.staff !== tmpl.staff) nn.originalStaff = tmpl.staff;
            return withPost(nn, res.notNeeded, tmpl.time);
          } else if (res.openPost) {
            var out = {
              time: tmpl.time,
              location: tmpl.location,
              staff: res.staff,
              status: 'needs_coverage'
            };
            if (res.staff !== tmpl.staff) out.originalStaff = tmpl.staff;
            return withPost(out, res.openPost, tmpl.time);
          } else if (res.staff !== tmpl.staff) {
            return withPost({
              time: tmpl.time,
              location: tmpl.location,
              staff: res.staff,
              originalStaff: tmpl.staff,
              status: 'covered'
            }, res.lastPost, tmpl.time);
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

// --- POST Endpoints -----------------------------------------

function doPost(e) {
  // Serialize all writes so two people acting at once can't corrupt
  // scores or double-claim a shift (read-modify-write on the Sheet).
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (lockErr) {
    return jsonResponse({ status: 'error', message: 'Server busy \u2014 please try again.' });
  }
  try {
    var data = JSON.parse(e.postData.contents);
    var action = data.action;

    // -- Post a new shift --
    if (action === 'postShift') {
      var sheet = getSheet('Shifts');

      // Reject duplicates: same person, same date, same start time,
      // still active. (Bryleigh once posted the same shift twice and it
      // got covered twice -- double-counting both people's scores.)
      var existing = sheetToObjects(sheet);
      for (var i = 0; i < existing.length; i++) {
        var s = existing[i];
        if (s.PostedBy === data.postedBy &&
            String(s.ShiftDate) === String(data.shiftDate) &&
            String(s.StartTime) === String(data.startTime) &&
            (s.Status === 'open' || s.Status === 'claimed')) {
          var msg = s.Status === 'open'
            ? 'This shift is already on the board.'
            : 'This shift was already posted \u2014 ' + s.ClaimedBy + ' is covering it.';
          return jsonResponse({ status: 'error', message: msg });
        }
      }

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

    // -- Claim a shift --
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

      // Log to history -- but not self-covers ("I'll Work It"), which
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

    // -- Admin: put a different person on one shift, for one date --
    // Scores count it like a normal cover: the person taken off -1, the
    // person put on +1. If the shift is already posted as needing cover,
    // the new person simply claims that post (its poster already got -1).
    if (action === 'reassignShift') {
      if (String(data.pin) !== getAdminPIN()) {
        return jsonResponse({ status: 'error', message: 'Incorrect admin PIN.' });
      }
      var fromName = String(data.fromName || '').trim();
      var toName = String(data.toName || '').trim();
      var rDate = String(data.shiftDate || '').substring(0, 10);
      var rStart = String(data.startTime || '').trim();
      var rEnd = String(data.endTime || '').trim();
      var rLoc = String(data.location || '').trim();
      if (!fromName || !toName || !rDate) {
        return jsonResponse({ status: 'error', message: 'Missing shift details.' });
      }
      if (fromName === toName) {
        return jsonResponse({ status: 'error', message: toName + ' already has this shift.' });
      }
      var span = clockSpan_(rStart, rEnd);
      if (!span) {
        return jsonResponse({ status: 'error', message: 'Could not read the shift times.' });
      }
      var onStaff = sheetToObjects(getSheet('Staff')).some(function(st) {
        return String(st.Name).trim() === toName;
      });
      if (!onStaff) {
        return jsonResponse({ status: 'error', message: toName + ' is not on the staff list.' });
      }

      var rSheet = getSheet('Shifts');
      var rRows = sheetToObjects(rSheet);
      var openPost = null;
      for (var ri = 0; ri < rRows.length; ri++) {
        var rr = rRows[ri];
        if (String(rr.PostedBy) !== fromName) continue;
        if (String(rr.ShiftDate).substring(0, 10) !== rDate) continue;
        if (rr.Status !== 'open') continue;
        var rs = clockSpan_(rr.StartTime, rr.EndTime);
        if (rs && Math.min(rs.end, span.end) - Math.max(rs.start, span.start) <= 0) continue;
        openPost = rr;
        break;
      }

      var nowIso = new Date().toISOString();
      var recordId;
      if (openPost) {
        var prow = findRowByID(rSheet, openPost.ID);
        if (prow === -1) return jsonResponse({ status: 'error', message: 'Shift not found.' });
        rSheet.getRange(prow, 8).setValue('claimed');
        rSheet.getRange(prow, 9).setValue(toName);
        rSheet.getRange(prow, 11).setValue(nowIso);
        updateScore(toName, 1);
        recordId = String(openPost.ID);
      } else {
        recordId = String(Date.now());
        rSheet.appendRow([recordId, fromName, rDate, rStart, rEnd, rLoc,
                          'Changed by admin', 'claimed', toName, nowIso, nowIso]);
        updateScore(fromName, -1);
        updateScore(toName, 1);
      }
      getSheet('History').appendRow([recordId, fromName, toName, rDate, nowIso]);

      notifyShiftChanged_(fromName, toName, rDate, rStart, rEnd, rLoc);
      return jsonResponse({ status: 'ok', claimedExistingPost: !!openPost });
    }

    // -- Admin: a shift is not needed this date (someone can't work and no
    // cover is wanted). No points either way; if it had been posted, the
    // poster's -1 is given back. Only the person on the shift is emailed.
    if (action === 'markNotNeeded') {
      if (String(data.pin) !== getAdminPIN()) {
        return jsonResponse({ status: 'error', message: 'Incorrect admin PIN.' });
      }
      var nName = String(data.staffName || '').trim();
      var nDate = String(data.shiftDate || '').substring(0, 10);
      var nStart = String(data.startTime || '').trim();
      var nEnd = String(data.endTime || '').trim();
      var nLoc = String(data.location || '').trim();
      var nSpan = clockSpan_(nStart, nEnd);
      if (!nName || !nDate || !nSpan) {
        return jsonResponse({ status: 'error', message: 'Missing shift details.' });
      }
      var nSheet = getSheet('Shifts');
      var nRows = sheetToObjects(nSheet);
      var nOpen = null;
      for (var ni = 0; ni < nRows.length; ni++) {
        var nr = nRows[ni];
        if (String(nr.PostedBy) !== nName) continue;
        if (String(nr.ShiftDate).substring(0, 10) !== nDate) continue;
        if (nr.Status !== 'open' && nr.Status !== 'not_needed') continue;
        var nrs = clockSpan_(nr.StartTime, nr.EndTime);
        if (nrs && Math.min(nrs.end, nSpan.end) - Math.max(nrs.start, nSpan.start) <= 0) continue;
        if (nr.Status === 'not_needed') {
          return jsonResponse({ status: 'error', message: 'This shift is already marked not needed.' });
        }
        nOpen = nr;
        break;
      }
      var nNow = new Date().toISOString();
      if (nOpen) {
        // It was on the Board: take it off and give the poster their point back.
        var nRow = findRowByID(nSheet, nOpen.ID);
        nSheet.getRange(nRow, 8).setValue('not_needed');
        nSheet.getRange(nRow, 9).setValue('was posted');
        nSheet.getRange(nRow, 11).setValue(nNow);
        updateScore(nName, 1);
      } else {
        nSheet.appendRow([String(Date.now()), nName, nDate, nStart, nEnd, nLoc,
                          'Not needed (admin)', 'not_needed', '', nNow, nNow]);
      }
      notifyNotNeeded_(nName, nDate, nStart, nEnd, nLoc);
      return jsonResponse({ status: 'ok', wasPosted: !!nOpen });
    }

    // -- Admin: undo "not needed". A shift that had been posted goes back on
    // the Board (and the poster's -1 comes back); otherwise the marker is
    // simply removed and the shift is back to normal.
    if (action === 'undoNotNeeded') {
      if (String(data.pin) !== getAdminPIN()) {
        return jsonResponse({ status: 'error', message: 'Incorrect admin PIN.' });
      }
      var uSheet = getSheet('Shifts');
      var uRow = findRowByID(uSheet, data.id);
      if (uRow === -1) return jsonResponse({ status: 'error', message: 'Shift not found.' });
      if (uSheet.getRange(uRow, 8).getValue() !== 'not_needed') {
        return jsonResponse({ status: 'error', message: 'That shift is not marked not needed.' });
      }
      if (String(uSheet.getRange(uRow, 9).getValue()) === 'was posted') {
        uSheet.getRange(uRow, 8).setValue('open');
        uSheet.getRange(uRow, 9).setValue('');
        uSheet.getRange(uRow, 11).setValue('');
        updateScore(String(uSheet.getRange(uRow, 2).getValue()), -1);
        return jsonResponse({ status: 'ok', backOnBoard: true });
      }
      uSheet.deleteRow(uRow);
      return jsonResponse({ status: 'ok', backOnBoard: false });
    }

    // -- Change the hours on a posted shift (open or already covered). The
    // person who posted it can, or an admin with the PIN. If someone has
    // already taken it, both of them are emailed the new hours.
    if (action === 'editShiftHours') {
      var eSheet = getSheet('Shifts');
      var eRow = findRowByID(eSheet, data.id);
      if (eRow === -1) return jsonResponse({ status: 'error', message: 'Shift not found.' });
      var eStatus = eSheet.getRange(eRow, 8).getValue();
      if (eStatus !== 'open' && eStatus !== 'claimed') {
        return jsonResponse({ status: 'error', message: 'This shift can no longer be changed.' });
      }
      var ePoster = String(eSheet.getRange(eRow, 2).getValue());
      var eBy = String(data.by || '').trim();
      var eAdmin = data.pin !== undefined && data.pin !== '' && String(data.pin) === getAdminPIN();
      if (!eAdmin && eBy !== ePoster) {
        return jsonResponse({ status: 'error', message: 'Only ' + ePoster + ' or an admin can change these hours.' });
      }
      var eStart = String(data.startTime || '').trim(), eEnd = String(data.endTime || '').trim();
      if (!clockSpan_(eStart, eEnd)) {
        return jsonResponse({ status: 'error', message: 'The end time must be after the start time.' });
      }
      eSheet.getRange(eRow, 4).setValue(eStart);
      eSheet.getRange(eRow, 5).setValue(eEnd);
      if (eStatus === 'claimed') {
        var eClaimer = String(eSheet.getRange(eRow, 9).getValue());
        var eDate = eSheet.getRange(eRow, 3).getValue();
        notifyHoursChanged_(ePoster, eClaimer, eDate, eStart, eEnd, String(eSheet.getRange(eRow, 6).getValue()));
      }
      return jsonResponse({ status: 'ok', emailed: eStatus === 'claimed' });
    }

    // -- Claim an open (unfilled) shift from the schedule --
    if (action === 'claimOpenShift') {
      var sheet = getSheet('Shifts');

      // Reject if this open slot is already claimed (same date + time)
      var existingOpen = sheetToObjects(sheet);
      for (var i = 0; i < existingOpen.length; i++) {
        var os = existingOpen[i];
        if (os.PostedBy === 'Open' &&
            String(os.ShiftDate) === String(data.shiftDate) &&
            String(os.StartTime) === String(data.time) &&
            os.Status === 'claimed') {
          return jsonResponse({ status: 'error', message: 'That shift was already claimed by ' + os.ClaimedBy + '.' });
        }
      }

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

    // -- Cancel own shift (before claimed) --
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

    // -- Admin: Delete a shift --
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

    // -- Admin: Reset all scores --
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

    // -- Admin: Broadcast a message to all staff --
    if (action === 'broadcastMessage') {
      if (String(data.pin) !== getAdminPIN()) {
        return jsonResponse({ status: 'error', message: 'Invalid admin PIN.' });
      }
      var msg = String(data.message || '').trim();
      if (!msg) {
        return jsonResponse({ status: 'error', message: 'Message is empty.' });
      }
      var subject = String(data.subject || '').trim() || 'Message from Shift Coverage';

      var emails = getStaffEmails();
      var recipients = [];
      for (var name in emails) {
        if (emails[name] && recipients.indexOf(emails[name]) === -1) recipients.push(emails[name]);
      }
      var mgr = getManagerEmail();
      if (mgr && recipients.indexOf(mgr) === -1) recipients.push(mgr);

      if (recipients.length === 0) {
        return jsonResponse({ status: 'error', message: 'No staff emails on file.' });
      }
      MailApp.sendEmail({ to: recipients.join(','), subject: subject, body: msg });
      return jsonResponse({ status: 'ok' });
    }

    // -- Admin: Email all open shifts to staff right now --
    if (action === 'sendDigestNow') {
      if (String(data.pin) !== getAdminPIN()) {
        return jsonResponse({ status: 'error', message: 'Invalid admin PIN.' });
      }
      var sent = sendCoverageDigest();
      return jsonResponse({ status: 'ok', count: sent });
    }

    // -- Admin: Add staff --
    if (action === 'addStaff') {
      if (String(data.pin) !== getAdminPIN()) {
        return jsonResponse({ status: 'error', message: 'Invalid admin PIN.' });
      }

      var name = String(data.name || '').trim();
      if (!name) {
        return jsonResponse({ status: 'error', message: 'Give the person a name.' });
      }

      var staffSheet = getSheet('Staff');
      var rows = staffSheet.getDataRange().getValues();
      var headers = rows[0];

      // Already on the list? Adding again would give them two entries and
      // split their score between them.
      for (var i = 1; i < rows.length; i++) {
        if (String(rows[i][0]).trim().toLowerCase() === name.toLowerCase()) {
          return jsonResponse({ status: 'error', message: name + ' is already on the staff list.' });
        }
      }

      // Build the row to match the tab's own columns rather than assuming an
      // order, so Email lands in the Email column wherever it happens to be.
      // Leaving it blank is what kept new staff off the shift-alert emails.
      var row = [];
      for (var j = 0; j < headers.length; j++) {
        var head = String(headers[j]).trim().toLowerCase();
        if (head === 'name') row.push(name);
        else if (head === 'score') row.push(0);
        else if (head === 'isadmin') row.push(false);
        else if (head === 'email') row.push(String(data.email || '').trim());
        else row.push('');
      }
      staffSheet.appendRow(row);
      return jsonResponse({ status: 'ok' });
    }

    // -- Admin: Remove staff --
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

// --- Score Helper -------------------------------------------

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

// --- Email Helpers -----------------------------------------

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

// Minutes since midnight from "8:00", "13:00", "8:00 AM" or "1:00 PM".
// null if it can't be read.
function clockMinutes_(t) {
  var m = String(t == null ? '' : t).trim().match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])?$/);
  if (!m) return null;
  var h = parseInt(m[1], 10), min = parseInt(m[2], 10);
  if (m[3]) {
    h = h % 12;
    if (m[3].charAt(0).toUpperCase() === 'P') h += 12;
  }
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// {start, end} in minutes, from a start and end, or from one string holding
// both ("8:00 AM - 3:00 PM", with any dash). null unless both can be read.
function clockSpan_(startStr, endStr) {
  var a = String(startStr == null ? '' : startStr), b = String(endStr == null ? '' : endStr);
  var parts = a.split(/\s*[\u2013\u2014-]\s*/);
  if (parts.length >= 2) { a = parts[0]; if (!b) b = parts[1]; }
  var s = clockMinutes_(a), e = clockMinutes_(b);
  if (s === null || e === null || e <= s) return null;
  return { start: s, end: e };
}

// 480 -> "08:00"
function minutesTo24h_(mins) {
  var h = Math.floor(mins / 60), m = mins % 60;
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}

// 780 -> "1:00 PM"
function minutesToLabel12_(mins) {
  var h = Math.floor(mins / 60), m = mins % 60;
  var ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
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

// When an admin changes who works a shift, the two people it affects -- the
// person taken off and the person put on -- get one email between them.
function notifyShiftChanged_(fromName, toName, shiftDate, startTime, endTime, location) {
  try {
    var emails = getStaffEmails();
    var dateStr = formatDateForEmail(shiftDate);
    var timeStr = formatTimeForEmail(startTime) + ' - ' + formatTimeForEmail(endTime);
    var body = 'Schedule change:\n\n'
      + toName + ' is working ' + fromName + '\'s shift.\n\n'
      + 'Date: ' + dateStr + '\n'
      + 'Time: ' + timeStr + (location ? ' at ' + location : '') + '\n\n'
      + 'See the schedule in the Shift Coverage app:\n'
      + 'https://drtennisman.github.io/shift-coverage-app/';
    var recipients = [];
    [fromName, toName].forEach(function(n) {
      if (emails[n] && recipients.indexOf(emails[n]) === -1) recipients.push(emails[n]);
    });
    if (recipients.length > 0) {
      MailApp.sendEmail({
        to: recipients.join(','),
        subject: 'Schedule change - ' + toName + ' working ' + fromName + '\'s shift on ' + dateStr,
        body: body
      });
    }
  } catch (e) {
    // Don't fail the main action if email fails
  }
}

// Tells the person on a shift that it isn't needed this date.
function notifyNotNeeded_(name, shiftDate, startTime, endTime, location) {
  try {
    var to = getStaffEmails()[name];
    if (!to) return;
    var dateStr = formatDateForEmail(shiftDate);
    MailApp.sendEmail({
      to: to,
      subject: 'Shift not needed - ' + dateStr,
      body: 'Your shift is not needed this time, so you do not need to come in:\n\n'
        + 'Date: ' + dateStr + '\n'
        + 'Time: ' + formatTimeForEmail(startTime) + ' - ' + formatTimeForEmail(endTime)
        + (location ? ' at ' + location : '') + '\n\n'
        + 'No points are taken off.\n\n'
        + 'https://drtennisman.github.io/shift-coverage-app/'
    });
  } catch (e) {
    // Don't fail the main action if email fails
  }
}

// Tells both people on a covered shift that its hours changed.
function notifyHoursChanged_(poster, claimer, shiftDate, startTime, endTime, location) {
  try {
    var emails = getStaffEmails();
    var recipients = [];
    [poster, claimer].forEach(function(n) {
      if (emails[n] && recipients.indexOf(emails[n]) === -1) recipients.push(emails[n]);
    });
    if (!recipients.length) return;
    var dateStr = formatDateForEmail(shiftDate);
    var timeStr = formatTimeForEmail(startTime) + ' - ' + formatTimeForEmail(endTime);
    MailApp.sendEmail({
      to: recipients.join(','),
      subject: 'New hours - ' + claimer + ' covering ' + poster + ' on ' + dateStr,
      body: 'The hours changed on a covered shift:\n\n'
        + claimer + ' is covering ' + poster + '\'s shift.\n\n'
        + 'Date: ' + dateStr + '\n'
        + 'New time: ' + timeStr + (location ? ' at ' + location : '') + '\n\n'
        + 'https://drtennisman.github.io/shift-coverage-app/'
    });
  } catch (e) {
    // Don't fail the main action if email fails
  }
}

// --- Coverage Reminder Digest -------------------------------
// Run setupWeeklyReminder() ONCE from the editor to schedule this for
// Sunday evening (~6 PM) each week. Also fired on demand by the admin
// "Email Open Shifts Now" button. sendCoverageDigest emails everyone the
// list of shifts still needing coverage, with anything within 48 hours
// flagged URGENT. Stays silent (sends nothing) when nothing is open.
// Returns the number of open shifts (0 = nothing sent) for the manual
// button's feedback.

function sendCoverageDigest() {
  try {
    expirePastShifts();
    var shifts = sheetToObjects(getSheet('Shifts'));
    var open = shifts.filter(function(s) { return s.Status === 'open'; });
    if (open.length === 0) return 0; // nothing to nag about

    // Sort by date ascending
    open.sort(function(a, b) { return new Date(a.ShiftDate) - new Date(b.ShiftDate); });

    var now = new Date();
    var urgentLines = [];
    var upcomingLines = [];

    open.forEach(function(s) {
      var dateStr = formatDateForEmail(s.ShiftDate);
      var timeStr = formatTimeForEmail(s.StartTime) + ' - ' + formatTimeForEmail(s.EndTime);
      var loc = s.Location ? ' @ ' + s.Location : '';
      var who = (s.PostedBy === 'Open') ? 'Open shift' : s.PostedBy;
      var line = '- ' + dateStr + ', ' + timeStr + loc + ' (' + who + ')';

      var shiftDate = new Date(String(s.ShiftDate).substring(0, 10) + 'T00:00:00');
      var hoursUntil = (shiftDate - now) / (1000 * 60 * 60);
      if (hoursUntil <= 48) {
        urgentLines.push(line);
      } else {
        upcomingLines.push(line);
      }
    });

    var body = 'These shifts still need someone to cover them:\n\n';
    if (urgentLines.length > 0) {
      body += '** URGENT (within 48 hours) **\n' + urgentLines.join('\n') + '\n\n';
    }
    if (upcomingLines.length > 0) {
      body += 'Upcoming:\n' + upcomingLines.join('\n') + '\n\n';
    }
    body += 'Grab one in the app:\nhttps://drtennisman.github.io/shift-coverage-app/';

    var count = open.length;
    var subject = count + ' shift' + (count === 1 ? '' : 's') + ' still need'
      + (count === 1 ? 's' : '') + ' coverage'
      + (urgentLines.length > 0 ? ' - some URGENT' : '');

    // Send to all staff + manager
    var emails = getStaffEmails();
    var recipients = [];
    for (var name in emails) {
      if (emails[name] && recipients.indexOf(emails[name]) === -1) recipients.push(emails[name]);
    }
    var managerEmail = getManagerEmail();
    if (managerEmail && recipients.indexOf(managerEmail) === -1) recipients.push(managerEmail);

    if (recipients.length > 0) {
      MailApp.sendEmail({ to: recipients.join(','), subject: subject, body: body });
    }
    return open.length;
  } catch (e) {
    // Never throw from a scheduled job
    return 0;
  }
}

function setupWeeklyReminder() {
  // Remove any existing digest triggers so re-running doesn't stack them
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendCoverageDigest') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  // Schedule for Sunday ~6 PM each week
  ScriptApp.newTrigger('sendCoverageDigest')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(18)
    .create();
  return 'Weekly coverage reminder scheduled for Sunday ~6 PM.';
}
