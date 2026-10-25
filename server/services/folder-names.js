// Display names for special folders. Some servers (Exchange among them) call the Sent folder "Sent Items";
// the shorter name reads better in a narrow list and header. Only the shown name changes, never the path.
const SHORT = {
  sent: [/^sent items$/i, 'Sent'],
};

function tidy(folders) {
  return folders.map((f) => {
    const rule = SHORT[f.role];
    return rule && rule[0].test(String(f.name || '')) ? { ...f, name: rule[1] } : f;
  });
}

module.exports = { tidy };
