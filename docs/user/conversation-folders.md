# Conversation folders

Folders organize conversations across projects. Every client connected to a server sees the same folders; which ones are collapsed is remembered per device.

## Use them

The sidebar lists conversations in folders. Conversations you have not filed are under **Unfiled**.

- The folder icon beside the sidebar search adds a top-level folder, and the sparkle icon adds a smart folder. A folder's menu adds a subfolder, up to 8 levels deep.
- Drag a conversation onto a folder to file it, or onto **Unfiled** to take it out. A conversation lives in one folder.
- To move several, `mod`-click to select them and drag any one of them.
- Drag a folder onto another to nest it.
- From the keyboard, run **Move this conversation to a folder** from the command palette.

Deleting a folder never deletes conversations. They show as unfiled, and **Undo** puts everything back where it was.

The folder tree shows one server at a time: the one the open conversation belongs to.

On mobile, long-press a conversation for **Move to folder** and **Browse folders**.

## Smart folders

A smart folder is a saved filter instead of a place: **Running**, **Needs input**, or **This week**. A conversation can appear in a smart folder and still live in a regular folder. Add one from **Smart folder** above the tree.

## Agents

Agents can reorganize folders through the `t3_folder_list` and `t3_folder_update` tools. Ask one to tidy up your sidebar.
