/**
 * Creates the lead-tracking spreadsheet for the n8n SMS booking engine.
 *
 * HOW TO RUN
 *   1. Go to https://script.google.com/  ->  New project
 *   2. Delete the stub code, paste this file, Save
 *   3. Run  ->  createLeadsSheet   (approve the one-time permission prompt)
 *   4. View -> Logs   (or Ctrl+Enter) to get the spreadsheet ID
 *
 * The tab MUST be named exactly "Leads" and the headers must match exactly -
 * the n8n Google Sheets node appends by header name, so a rename or a typo
 * silently writes blank columns.
 */

var HEADERS = [
  'Timestamp',
  'Lead Name',
  'Phone',
  'Source Channel',
  'Status',
  'Booking Time',
  'Notes',
];

var WIDTHS = [170, 160, 140, 130, 170, 170, 420];

function createLeadsSheet() {
  var ss = SpreadsheetApp.create('Lead Tracking - SMS Booking Engine');

  var sheet = ss.getSheets()[0];
  sheet.setName('Leads');

  var header = sheet.getRange(1, 1, 1, HEADERS.length);
  header.setValues([HEADERS]);
  header.setFontWeight('bold');
  header.setBackground('#1f2937');
  header.setFontColor('#ffffff');
  sheet.setFrozenRows(1);

  for (var i = 0; i < WIDTHS.length; i++) {
    sheet.setColumnWidth(i + 1, WIDTHS[i]);
  }

  // Notes can get long; keep rows from ballooning.
  sheet.getRange(1, HEADERS.length, sheet.getMaxRows(), 1).setWrap(false);

  // Trim the default 26 columns down to what we actually use.
  if (sheet.getMaxColumns() > HEADERS.length) {
    sheet.deleteColumns(HEADERS.length + 1, sheet.getMaxColumns() - HEADERS.length);
  }

  var id = ss.getId();
  Logger.log('----------------------------------------');
  Logger.log('Spreadsheet ID (client_configs.google_sheet_id):');
  Logger.log(id);
  Logger.log('URL: ' + ss.getUrl());
  Logger.log('----------------------------------------');
  return id;
}
