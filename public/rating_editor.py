import os
import sys
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

# Ensure mutagen and just_playback are installed, otherwise prompt the user with instructions
try:
    from mutagen.id3 import ID3, TALB, TIT2, TPE1, POPM
    from mutagen.mp3 import MP3
    from just_playback import Playback
    DEPENDENCIES_AVAILABLE = True
except ImportError:
    DEPENDENCIES_AVAILABLE = False


def format_time(seconds):
    if seconds is None:
        return "00:00"
    mins = int(seconds // 60)
    secs = int(seconds % 60)
    return f"{mins:02d}:{secs:02d}"


class RatingEditorApp:
    def __init__(self, root):
        self.root = root
        self.root.title("DancePlayer Audio Rating Editor")
        self.root.geometry("800x600")
        self.root.minsize(700, 500)

        # Style configurations
        self.style = ttk.Style()
        self.style.theme_use("clam")
        
        # Color palette
        self.bg_color = "#1e1e24"
        self.fg_color = "#ffffff"
        self.accent_color = "#00b06b"
        self.btn_bg = "#2d2d30"
        self.btn_active = "#3e3e42"
        self.star_color = "#e89f3e"

        # Apply root background
        self.root.configure(bg=self.bg_color)

        self.current_folder = ""
        self.mp3_files = []
        self.selected_file_path = None
        self.selected_rating = 0  # 0 to 5
        self.playback = None
        self.confirm_delete_going_forward = True

        # Bind window close event to clean up audio thread
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

        # If dependencies are missing, show warning screen
        if not DEPENDENCIES_AVAILABLE:
            self.show_missing_dependency_screen()
            return

        self.build_ui()

    def show_missing_dependency_screen(self):
        frame = tk.Frame(self.root, bg=self.bg_color)
        frame.pack(expand=True, fill="both", padx=40, pady=40)

        label_title = tk.Label(
            frame, 
            text="Dependencies Missing", 
            fg="#e53935", 
            bg=self.bg_color, 
            font=("Arial", 16, "bold")
        )
        label_title.pack(pady=20)

        label_desc = tk.Label(
            frame, 
            text="This helper app requires the 'mutagen' and 'just_playback' libraries.\n\n"
                 "Please run the following command in your terminal/cmd to install them:", 
            fg=self.fg_color, 
            bg=self.bg_color, 
            font=("Arial", 11)
        )
        label_desc.pack(pady=10)

        cmd_entry = tk.Entry(frame, font=("Courier", 12), width=35, justify="center")
        cmd_entry.insert(0, "pip install mutagen just_playback")
        cmd_entry.configure(state="readonly")
        cmd_entry.pack(pady=10)

        btn_retry = ttk.Button(frame, text="I installed them, try again!", command=self.restart_app)
        btn_retry.pack(pady=20)

    def restart_app(self):
        os.execv(sys.executable, ['python'] + sys.argv)

    def build_ui(self):
        # Top toolbar
        toolbar = tk.Frame(self.root, bg=self.bg_color, bd=1, relief="raised", height=50)
        toolbar.pack(fill="x", side="top", ipady=5)

        btn_select_dir = tk.Button(
            toolbar,
            text="📁 Select Folder",
            bg=self.btn_bg,
            fg=self.fg_color,
            activebackground=self.btn_active,
            activeforeground=self.fg_color,
            bd=0,
            padx=15,
            pady=6,
            font=("Arial", 10, "bold"),
            command=self.select_directory
        )
        btn_select_dir.pack(side="left", padx=15, pady=5)

        self.label_folder = tk.Label(
            toolbar,
            text="No folder selected",
            fg="#8a9aa3",
            bg=self.bg_color,
            font=("Arial", 9, "italic")
        )
        self.label_folder.pack(side="left", padx=10)

        # Main window split: Left side files list, Right side editor
        main_pane = tk.PanedWindow(self.root, orient="horizontal", bg=self.bg_color, bd=0, sashwidth=4)
        main_pane.pack(fill="both", expand=True, padx=10, pady=10)

        # Left Panel (Files List)
        left_frame = tk.Frame(main_pane, bg=self.bg_color)
        left_frame.pack(fill="both", expand=True)

        lbl_list = tk.Label(left_frame, text="Audio Files (.mp3)", fg=self.fg_color, bg=self.bg_color, font=("Arial", 10, "bold"), anchor="w")
        lbl_list.pack(fill="x", pady=(0, 5))

        list_container = tk.Frame(left_frame, bg=self.bg_color)
        list_container.pack(fill="both", expand=True)

        scrollbar = tk.Scrollbar(list_container, orient="vertical")
        scrollbar.pack(side="right", fill="y")

        self.files_listbox = tk.Listbox(
            list_container,
            bg="#121214",
            fg=self.fg_color,
            selectbackground=self.accent_color,
            selectforeground="#ffffff",
            bd=0,
            highlightthickness=0,
            yscrollcommand=scrollbar.set,
            font=("Arial", 10)
        )
        self.files_listbox.pack(fill="both", expand=True)
        scrollbar.config(command=self.files_listbox.yview)
        self.files_listbox.bind("<<ListboxSelect>>", self.on_file_selected)

        # Right Panel (Editor View)
        self.right_frame = tk.Frame(main_pane, bg="#252529", padx=15, pady=15)
        self.right_frame.pack(fill="both", expand=True)

        # Placeholder message when no file is selected
        self.placeholder_label = tk.Label(
            self.right_frame,
            text="Select a song from the list to edit its metadata and ratings.",
            fg="#8a9aa3",
            bg="#252529",
            font=("Arial", 11, "italic"),
            wraplength=300
        )
        self.placeholder_label.pack(expand=True)

        # Editor UI fields (initially hidden)
        self.editor_container = tk.Frame(self.right_frame, bg="#252529")
        
        # File path display label
        self.lbl_file_title = tk.Label(self.editor_container, text="Song Metadata", fg=self.fg_color, bg="#252529", font=("Arial", 12, "bold"), anchor="w")
        self.lbl_file_title.pack(fill="x", pady=(0, 10))

        # Title Field
        lbl_title = tk.Label(self.editor_container, text="TITLE", fg="#8a9aa3", bg="#252529", font=("Arial", 8, "bold"), anchor="w")
        lbl_title.pack(fill="x", pady=(5, 2))
        self.entry_title = tk.Entry(self.editor_container, bg=self.bg_color, fg=self.fg_color, insertbackground=self.fg_color, bd=1, relief="solid", font=("Arial", 10))
        self.entry_title.pack(fill="x", ipady=4, pady=(0, 10))

        # Artist Field
        lbl_artist = tk.Label(self.editor_container, text="ARTIST", fg="#8a9aa3", bg="#252529", font=("Arial", 8, "bold"), anchor="w")
        lbl_artist.pack(fill="x", pady=(5, 2))
        self.entry_artist = tk.Entry(self.editor_container, bg=self.bg_color, fg=self.fg_color, insertbackground=self.fg_color, bd=1, relief="solid", font=("Arial", 10))
        self.entry_artist.pack(fill="x", ipady=4, pady=(0, 10))

        # Album Field
        lbl_album = tk.Label(self.editor_container, text="ALBUM", fg="#8a9aa3", bg="#252529", font=("Arial", 8, "bold"), anchor="w")
        lbl_album.pack(fill="x", pady=(5, 2))
        self.entry_album = tk.Entry(self.editor_container, bg=self.bg_color, fg=self.fg_color, insertbackground=self.fg_color, bd=1, relief="solid", font=("Arial", 10))
        self.entry_album.pack(fill="x", ipady=4, pady=(0, 10))

        # Rating Stars Field
        lbl_rating = tk.Label(self.editor_container, text="RATING", fg="#8a9aa3", bg="#252529", font=("Arial", 8, "bold"), anchor="w")
        lbl_rating.pack(fill="x", pady=(5, 2))
        
        self.stars_frame = tk.Frame(self.editor_container, bg="#252529")
        self.stars_frame.pack(fill="x", pady=(0, 15))
        self.star_labels = []
        for star_idx in range(1, 6):
            lbl_star = tk.Label(
                self.stars_frame,
                text="☆",
                fg=self.star_color,
                bg="#252529",
                font=("Arial", 20, "bold"),
                cursor="hand2"
            )
            lbl_star.pack(side="left", padx=4)
            lbl_star.bind("<Button-1>", lambda event, idx=star_idx: self.set_rating_stars(idx))
            self.star_labels.append(lbl_star)

        # Clear rating button
        self.btn_clear_rating = tk.Button(
            self.stars_frame,
            text="Clear",
            bg=self.btn_bg,
            fg="#ff5252",
            activebackground=self.btn_active,
            activeforeground="#ff5252",
            bd=0,
            padx=8,
            pady=2,
            font=("Arial", 9),
            command=self.clear_rating
        )
        self.btn_clear_rating.pack(side="left", padx=15)

        # Separator for Playback Section
        sep = ttk.Separator(self.editor_container, orient="horizontal")
        sep.pack(fill="x", pady=10)

        # Playback Section
        lbl_playback = tk.Label(self.editor_container, text="TEST PLAYBACK", fg="#8a9aa3", bg="#252529", font=("Arial", 8, "bold"), anchor="w")
        lbl_playback.pack(fill="x", pady=(0, 5))

        self.playback_frame = tk.Frame(self.editor_container, bg="#252529")
        self.playback_frame.pack(fill="x", pady=(0, 15))

        self.btn_play = tk.Button(
            self.playback_frame,
            text="▶ Play",
            bg=self.btn_bg,
            fg=self.fg_color,
            activebackground=self.btn_active,
            activeforeground=self.fg_color,
            bd=0,
            padx=12,
            pady=6,
            font=("Arial", 9, "bold"),
            command=self.toggle_play
        )
        self.btn_play.pack(side="left", padx=(0, 10))

        self.btn_seek = tk.Button(
            self.playback_frame,
            text="⏩ +15s",
            bg=self.btn_bg,
            fg=self.fg_color,
            activebackground=self.btn_active,
            activeforeground=self.fg_color,
            bd=0,
            padx=12,
            pady=6,
            font=("Arial", 9, "bold"),
            command=self.seek_forward_15
        )
        self.btn_seek.pack(side="left", padx=(0, 15))

        self.lbl_time = tk.Label(
            self.playback_frame,
            text="00:00 / 00:00",
            fg=self.fg_color,
            bg="#252529",
            font=("Arial", 10)
        )
        self.lbl_time.pack(side="left")

        # Action Buttons row (Save Changes)
        btn_actions_frame = tk.Frame(self.editor_container, bg="#252529")
        btn_actions_frame.pack(fill="x", pady=(10, 0))

        self.btn_save = tk.Button(
            btn_actions_frame,
            text="💾 Save Changes",
            bg=self.accent_color,
            fg="#ffffff",
            activebackground="#008a52",
            activeforeground="#ffffff",
            bd=0,
            padx=20,
            pady=8,
            font=("Arial", 10, "bold"),
            command=self.save_metadata
        )
        self.btn_save.pack(side="left")

        self.btn_delete = tk.Button(
            btn_actions_frame,
            text="🗑 Delete File",
            bg="#e53935",
            fg="#ffffff",
            activebackground="#b71c1c",
            activeforeground="#ffffff",
            bd=0,
            padx=20,
            pady=8,
            font=("Arial", 10, "bold"),
            command=self.delete_file
        )
        self.btn_delete.pack(side="right")

        # Add both frames to pane
        main_pane.add(left_frame, minsize=200, stretch="always")
        main_pane.add(self.right_frame, minsize=350, stretch="always")

        # Start periodic label updater loop
        self.update_playback_loop()

    def get_file_rating(self, filepath):
        try:
            audio = MP3(filepath, ID3=ID3)
            if audio.tags is None:
                return 0
            popm_frames = audio.tags.getall("POPM")
            if popm_frames:
                raw_rating = popm_frames[0].rating
                if 1 <= raw_rating <= 63:
                    return 1
                elif 64 <= raw_rating <= 127:
                    return 2
                elif 128 <= raw_rating <= 195:
                    return 3
                elif 196 <= raw_rating <= 254:
                    return 4
                elif raw_rating == 255:
                    return 5
        except Exception:
            pass
        return 0

    def format_listbox_item(self, rel_path, rating):
        stars = "★" * rating + "☆" * (5 - rating)
        return f"{rel_path} [{stars}]"

    def select_directory(self):
        folder = filedialog.askdirectory(title="Choose Audio Folder")
        if not folder:
            return
        
        self.current_folder = folder
        self.label_folder.config(text=os.path.basename(folder))
        
        # Scan for mp3 files recursively
        self.mp3_files = []
        for root_dir, _, filenames in os.walk(folder):
            for file in filenames:
                if file.lower().endswith(".mp3"):
                    full_path = os.path.join(root_dir, file)
                    rel_path = os.path.relpath(full_path, folder)
                    rating = self.get_file_rating(full_path)
                    self.mp3_files.append((rel_path, full_path, rating))

        self.files_listbox.delete(0, tk.END)
        for rel_path, _, rating in self.mp3_files:
            self.files_listbox.insert(tk.END, self.format_listbox_item(rel_path, rating))

        self.selected_file_path = None
        self.confirm_delete_going_forward = True
        self.stop_playback()
        self.editor_container.pack_forget()
        self.placeholder_label.pack(expand=True)

    def on_file_selected(self, event):
        selection = self.files_listbox.curselection()
        if not selection:
            return
        
        idx = selection[0]
        _, self.selected_file_path, _ = self.mp3_files[idx]
        
        self.placeholder_label.pack_forget()
        self.editor_container.pack(fill="both", expand=True)

        self.stop_playback()
        self.load_metadata(self.selected_file_path)

    def load_metadata(self, filepath):
        try:
            audio = MP3(filepath, ID3=ID3)
            # Ensure ID3 tags initialized
            if audio.tags is None:
                audio.add_tags()
            tags = audio.tags
        except Exception as e:
            messagebox.showerror("Error", f"Failed to read file: {e}")
            return

        # Fetch Title, Artist, Album
        title = str(tags.get("TIT2", ""))
        artist = str(tags.get("TPE1", ""))
        album = str(tags.get("TALB", ""))

        self.entry_title.delete(0, tk.END)
        self.entry_title.insert(0, title)

        self.entry_artist.delete(0, tk.END)
        self.entry_artist.insert(0, artist)

        self.entry_album.delete(0, tk.END)
        self.entry_album.insert(0, album)

        # Load file into player
        if self.playback is None and DEPENDENCIES_AVAILABLE:
            try:
                self.playback = Playback()
            except Exception as e:
                print("Warning: Could not initialize audio device:", e)

        if self.playback:
            try:
                self.playback.load_file(filepath)
                self.btn_play.config(text="▶ Play", bg=self.btn_bg)
            except Exception as e:
                print("Error loading file in playback:", e)

        # Parse Rating (POPM Frame)
        rating_val = 0
        popm_frames = tags.getall("POPM")
        if popm_frames:
            raw_rating = popm_frames[0].rating
            # Convert raw POPM rating byte value (0-255) to 1-5 stars scale
            if 1 <= raw_rating <= 63:
                rating_val = 1
            elif 64 <= raw_rating <= 127:
                rating_val = 2
            elif 128 <= raw_rating <= 195:
                rating_val = 3
            elif 196 <= raw_rating <= 254:
                rating_val = 4
            elif raw_rating == 255:
                rating_val = 5
        
        self.set_rating_stars(rating_val)
        self.update_time_label()

    def set_rating_stars(self, count):
        self.selected_rating = count
        for i, lbl in enumerate(self.star_labels):
            if i < count:
                lbl.config(text="★")
            else:
                lbl.config(text="☆")

    def clear_rating(self):
        self.set_rating_stars(0)

    def toggle_play(self):
        if not self.playback:
            return
        
        if self.playback.playing:
            self.playback.pause()
            self.btn_play.config(text="▶ Play", bg=self.btn_bg)
        elif self.playback.paused:
            self.playback.resume()
            self.btn_play.config(text="⏸ Pause", bg=self.accent_color)
        else:
            if self.playback.curr_pos >= self.playback.duration - 0.5:
                # Seek to start if near the end
                self.playback.seek(0)
            self.playback.play()
            self.btn_play.config(text="⏸ Pause", bg=self.accent_color)

    def seek_forward_15(self):
        if not self.playback:
            return
        new_pos = min(self.playback.duration, max(0.0, self.playback.curr_pos) + 15.0)
        self.playback.seek(new_pos)
        self.update_time_label()

    def stop_playback(self):
        if self.playback:
            try:
                self.playback.stop()
            except Exception:
                pass
            self.btn_play.config(text="▶ Play", bg=self.btn_bg)
            self.update_time_label()

    def update_time_label(self):
        if not self.playback:
            self.lbl_time.config(text="00:00 / 00:00")
            return
        curr = max(0.0, self.playback.curr_pos)
        dur = self.playback.duration
        self.lbl_time.config(text=f"{format_time(curr)} / {format_time(dur)}")

    def update_playback_loop(self):
        if self.playback:
            if self.playback.playing:
                self.update_time_label()
                if self.playback.curr_pos >= self.playback.duration - 0.1:
                    self.stop_playback()
            elif self.btn_play.cget("text") == "⏸ Pause":
                self.stop_playback()
        self.root.after(200, self.update_playback_loop)

    def save_metadata(self):
        if not self.selected_file_path:
            return

        try:
            # Release the file handle on Windows so mutagen can write to it without permission denial
            self.stop_playback()
            self.playback = None

            audio = MP3(self.selected_file_path, ID3=ID3)
            if audio.tags is None:
                audio.add_tags()
            tags = audio.tags

            # Save basic texts
            tags["TIT2"] = TIT2(encoding=3, text=[self.entry_title.get().strip()])
            tags["TPE1"] = TPE1(encoding=3, text=[self.entry_artist.get().strip()])
            tags["TALB"] = TALB(encoding=3, text=[self.entry_album.get().strip()])

            # Save POPM Rating (Popularimeter) mapped to Windows/macOS values
            email_key = "Windows Media Player 9 Series"
            if self.selected_rating == 0:
                tags.delall("POPM")
            else:
                rating_bytes = {
                    1: 1,
                    2: 64,
                    3: 128,
                    4: 196,
                    5: 255
                }
                tags.setall("POPM", [POPM(email=email_key, rating=rating_bytes[self.selected_rating])])

            audio.save()

            # Re-initialize/load the playback since we released it
            if DEPENDENCIES_AVAILABLE:
                try:
                    self.playback = Playback()
                    self.playback.load_file(self.selected_file_path)
                except Exception as e:
                    print("Warning: Could not re-initialize audio device:", e)
            
            # Update rating in mp3_files and listbox
            for i, (rel_path, path, rating) in enumerate(self.mp3_files):
                if path == self.selected_file_path:
                    self.mp3_files[i] = (rel_path, path, self.selected_rating)
                    self.files_listbox.delete(i)
                    self.files_listbox.insert(i, self.format_listbox_item(rel_path, self.selected_rating))
                    self.files_listbox.selection_set(i)
                    break

            messagebox.showinfo("Success", "Metadata saved successfully!")
        except Exception as e:
            # Re-initialize/load playback on failure as well
            if self.playback is None and DEPENDENCIES_AVAILABLE:
                try:
                    self.playback = Playback()
                    self.playback.load_file(self.selected_file_path)
                except Exception:
                    pass
            messagebox.showerror("Error", f"Failed to save metadata: {e}")

    def delete_file(self):
        if not self.selected_file_path:
            return

        if self.confirm_delete_going_forward:
            answer = messagebox.askyesno(
                "Confirm Deletion",
                "Are you sure you want to delete this file?\n\nFuture deletions in this folder will NOT show this confirmation warning.",
                parent=self.root
            )
            if not answer:
                return
            self.confirm_delete_going_forward = False

        # Release the file handle on Windows before deletion
        self.stop_playback()
        self.playback = None

        try:
            os.remove(self.selected_file_path)
        except Exception as e:
            messagebox.showerror("Error", f"Failed to delete file:\n{e}", parent=self.root)
            return

        # Find and remove it from lists
        filepath_deleted = self.selected_file_path
        self.mp3_files = [item for item in self.mp3_files if item[1] != filepath_deleted]

        # Refresh Listbox
        self.files_listbox.delete(0, tk.END)
        for rel_path, _, rating in self.mp3_files:
            self.files_listbox.insert(tk.END, self.format_listbox_item(rel_path, rating))

        # Clear selection and view
        self.selected_file_path = None
        self.editor_container.pack_forget()
        self.placeholder_label.pack(expand=True)
        messagebox.showinfo("Deleted", "File deleted successfully.", parent=self.root)

    def on_close(self):
        self.stop_playback()
        self.root.destroy()


def report_callback_exception(exc, val, tb):
    import traceback
    err_msg = "".join(traceback.format_exception(exc, val, tb))
    try:
        with open("crash_log.txt", "a") as f:
            f.write(err_msg + "\n")
    except Exception:
        pass
    messagebox.showerror("Internal Error", err_msg)


if __name__ == "__main__":
    root = tk.Tk()
    root.report_callback_exception = report_callback_exception
    app = RatingEditorApp(root)
    root.mainloop()
