#!/usr/bin/env osascript -l JavaScript

// Auto-extract captcha_verified_at cookie from Chrome
// Run: osascript -l JavaScript get-cookie.scpt

var chrome = Application('Google Chrome');

function getCookie() {
  try {
    var js = "document.cookie.split('; ').find(c => c.startsWith('captcha_verified_at=')) || ''";
    return chrome.windows[0].activeTab().execute({javascript: js});
  } catch(e) {
    return '';
  }
}

// Navigate to squid.wtf if not there
var currentUrl = chrome.windows[0].activeTab().url();
if (!currentUrl.includes('squid.wtf')) {
  chrome.windows[0].activeTab().url = 'https://qobuz.squid.wtf/';
}

// Wait up to 30 seconds for the cookie to appear (ALTCHA solved)
var cookie = '';
for (var i = 0; i < 30; i++) {
  delay(1);
  cookie = getCookie();
  if (cookie) break;
}

if (cookie) {
  cookie; // Output the cookie value
} else {
  'NO_COOKIE'; // Cookie not found - ALTCHA not solved
}
