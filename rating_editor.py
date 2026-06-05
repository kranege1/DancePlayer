import os
import sys
import json
import tkinter as tk
import tkinter.font as tkfont
from tkinter import filedialog, messagebox, ttk

# Ensure mutagen and just_playback are installed, otherwise prompt the user with instructions
IMPORT_ERROR_MSG = ""
try:
    from mutagen.id3 import ID3, TALB, TIT2, TPE1, POPM
    from mutagen.mp3 import MP3
    from just_playback import Playback
    DEPENDENCIES_AVAILABLE = True
except ImportError as e:
    import traceback
    IMPORT_ERROR_MSG = traceback.format_exc()
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
        self.root.geometry("900x650")
        self.root.minsize(800, 500)

        # Initialize fonts
        self.font_normal = tkfont.Font(family="Arial", size=10)
        self.font_bold = tkfont.Font(family="Arial", size=10, weight="bold")
        self.font_small_bold = tkfont.Font(family="Arial", size=8, weight="bold")
        self.font_title = tkfont.Font(family="Arial", size=12, weight="bold")
        self.font_stars = tkfont.Font(family="Arial", size=20, weight="bold")
        self.font_italic = tkfont.Font(family="Arial", size=9, slant="italic")
        self.font_italic_large = tkfont.Font(family="Arial", size=11, slant="italic")

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

        if IMPORT_ERROR_MSG:
            lbl_err = tk.Label(frame, text="Debug Info (Error Traceback):", fg="#ff5252", bg=self.bg_color, font=("Arial", 9, "bold"))
            lbl_err.pack(pady=(10, 0))
            txt_err = tk.Text(frame, height=10, width=60, font=("Courier", 8), bg="#121214", fg="#ff5252", bd=0)
            txt_err.insert(tk.END, IMPORT_ERROR_MSG)
            txt_err.configure(state="disabled")
            txt_err.pack(pady=5)

        btn_retry = ttk.Button(frame, text="I installed them, try again!", command=self.restart_app)
        btn_retry.pack(pady=20)

    def restart_app(self):
        os.execv(sys.executable, ['python'] + sys.argv)

    def scale_fonts(self, val):
        factor = float(val) / 10.0
        self.font_normal.configure(size=int(10 * factor))
        self.font_bold.configure(size=int(10 * factor))
        self.font_small_bold.configure(size=int(8 * factor))
        self.font_title.configure(size=int(12 * factor))
        self.font_stars.configure(size=int(20 * factor))
        self.font_italic.configure(size=int(9 * factor))
        self.font_italic_large.configure(size=int(11 * factor))
        
        # Configure treeview styles dynamically
        self.style.configure("Treeview", font=self.font_normal, rowheight=int(25 * factor))
        self.style.configure("Treeview.Heading", font=self.font_bold)

    def format_stars(self, rating):
        return "★" * rating + "☆" * (5 - rating)

    def build_ui(self):
        # Configure Treeview style
        self.style.configure("Treeview",
            background="#121214",
            foreground=self.fg_color,
            fieldbackground="#121214",
            rowheight=25,
            font=self.font_normal
        )
        self.style.map("Treeview",
            background=[("selected", self.accent_color)],
            foreground=[("selected", "#ffffff")]
        )
        self.style.configure("Treeview.Heading",
            background=self.btn_bg,
            foreground=self.fg_color,
            relief="flat",
            font=self.font_bold
        )

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
            font=self.font_bold,
            command=self.select_directory
        )
        btn_select_dir.pack(side="left", padx=15, pady=5)

        self.label_folder = tk.Label(
            toolbar,
            text="No folder selected",
            fg="#8a9aa3",
            bg=self.bg_color,
            font=self.font_italic
        )
        self.label_folder.pack(side="left", padx=10)

        self.btn_sync_backup = tk.Button(
            toolbar,
            text="🔄 Sync from JSON Backup",
            bg=self.btn_bg,
            fg=self.fg_color,
            activebackground=self.btn_active,
            activeforeground=self.fg_color,
            bd=0,
            padx=15,
            pady=6,
            font=self.font_bold,
            command=self.sync_from_backup
        )
        self.btn_sync_backup.pack(side="left", padx=15, pady=5)
        self.btn_sync_backup.config(state="disabled")

        # Main window split: Left side files table, Right side editor
        main_pane = tk.PanedWindow(self.root, orient="horizontal", bg=self.bg_color, bd=0, sashwidth=4)
        main_pane.pack(fill="both", expand=True, padx=10, pady=10)

        # Left Panel (Files Table)
        left_frame = tk.Frame(main_pane, bg=self.bg_color)
        left_frame.pack(fill="both", expand=True)

        lbl_list = tk.Label(left_frame, text="Audio Files & Ratings (.mp3)", fg=self.fg_color, bg=self.bg_color, font=self.font_bold, anchor="w")
        lbl_list.pack(fill="x", pady=(0, 5))

        list_container = tk.Frame(left_frame, bg=self.bg_color)
        list_container.pack(fill="both", expand=True)

        scrollbar = tk.Scrollbar(list_container, orient="vertical")
        scrollbar.pack(side="right", fill="y")

        # Treeview table
        self.files_tree = ttk.Treeview(
            list_container,
            columns=("name", "rating"),
            show="headings",
            yscrollcommand=scrollbar.set
        )
        self.files_tree.heading("name", text="File Name", anchor="w")
        self.files_tree.heading("rating", text="Rating", anchor="center")
        self.files_tree.column("name", stretch=True, anchor="w")
        self.files_tree.column("rating", stretch=False, width=120, anchor="center")
        self.files_tree.pack(fill="both", expand=True)

        scrollbar.config(command=self.files_tree.yview)
        self.files_tree.bind("<<TreeviewSelect>>", self.on_file_selected)

        # Right Panel (Editor View + Bottom Controls)
        self.right_frame = tk.Frame(main_pane, bg="#252529", padx=15, pady=15)
        self.right_frame.pack(fill="both", expand=True)

        # Bottom controls (Look & Feel)
        self.bottom_controls = tk.Frame(self.right_frame, bg="#252529", pady=10)
        self.bottom_controls.pack(side="bottom", fill="x")

        # Initialize static font for controls to prevent them from resizing and shifting the slider
        self.font_control = tkfont.Font(family="Arial", size=10)

        # Left: Silent mode
        self.silent_mode_var = tk.BooleanVar(value=False)
        self.chk_silent = tk.Checkbutton(
            self.bottom_controls,
            text="Silent Mode (No Popups)",
            variable=self.silent_mode_var,
            bg="#252529",
            fg=self.fg_color,
            selectcolor="#252529",
            activebackground="#252529",
            activeforeground=self.fg_color,
            font=self.font_control
        )
        self.chk_silent.pack(side="left", padx=5)

        # Auto Play Mode
        self.auto_play_var = tk.BooleanVar(value=False)
        self.chk_autoplay = tk.Checkbutton(
            self.bottom_controls,
            text="Auto Play",
            variable=self.auto_play_var,
            bg="#252529",
            fg=self.fg_color,
            selectcolor="#252529",
            activebackground="#252529",
            activeforeground=self.fg_color,
            font=self.font_control
        )
        self.chk_autoplay.pack(side="left", padx=5)

        # Right: Font size slider
        lbl_slider = tk.Label(self.bottom_controls, text="Font Size:", fg="#8a9aa3", bg="#252529", font=self.font_control)
        lbl_slider.pack(side="left", padx=(20, 5))

        self.font_slider = tk.Scale(
            self.bottom_controls,
            from_=6,
            to=20,
            orient="horizontal",
            bg="#252529",
            fg=self.fg_color,
            highlightthickness=0,
            troughcolor=self.btn_bg,
            activebackground=self.accent_color,
            showvalue=True,
            font=self.font_control
        )
        self.font_slider.set(10)
        self.font_slider.pack(side="left", fill="x", expand=True, padx=5)
        
        # Apply scaling only when user releases mouse click or key press
        self.font_slider.bind("<ButtonRelease-1>", lambda e: self.scale_fonts(self.font_slider.get()))
        self.font_slider.bind("<KeyRelease>", lambda e: self.scale_fonts(self.font_slider.get()))

        # Top area: Editor details
        self.editor_area = tk.Frame(self.right_frame, bg="#252529")
        self.editor_area.pack(side="top", fill="both", expand=True)

        # Placeholder message when no file is selected
        self.placeholder_label = tk.Label(
            self.editor_area,
            text="Select a song from the list to edit its metadata and ratings.",
            fg="#8a9aa3",
            bg="#252529",
            font=self.font_italic_large,
            wraplength=300
        )
        self.placeholder_label.pack(expand=True)

        # Editor UI fields (initially hidden)
        self.editor_container = tk.Frame(self.editor_area, bg="#252529")
        
        # Action Buttons row (Save / Delete) - packed first at the bottom so it never gets squeezed
        btn_actions_frame = tk.Frame(self.editor_container, bg="#252529")
        btn_actions_frame.pack(side="bottom", fill="x", pady=(15, 0))

        self.btn_save = tk.Button(
            btn_actions_frame,
            text="💾 Save Changes",
            bg=self.accent_color,
            fg="#ffffff",
            activebackground="#008a52",
            activeforeground="#ffffff",
            bd=0,
            padx=20,
            pady=12,
            font=self.font_bold,
            command=self.save_metadata
        )
        self.btn_save.pack(side="left", fill="x", expand=True, padx=(0, 10))

        self.btn_delete = tk.Button(
            btn_actions_frame,
            text="🗑 Delete File",
            bg="#e53935",
            fg="#ffffff",
            activebackground="#b71c1c",
            activeforeground="#ffffff",
            bd=0,
            padx=20,
            pady=12,
            font=self.font_bold,
            command=self.delete_file
        )
        self.btn_delete.pack(side="right", fill="x", expand=True, padx=(10, 0))
        
        # File path display label
        self.lbl_file_title = tk.Label(self.editor_container, text="Song Metadata", fg=self.fg_color, bg="#252529", font=self.font_title, anchor="w")
        self.lbl_file_title.pack(fill="x", pady=(0, 10))

        # Title Field
        lbl_title = tk.Label(self.editor_container, text="TITLE", fg="#8a9aa3", bg="#252529", font=self.font_small_bold, anchor="w")
        lbl_title.pack(fill="x", pady=(5, 2))
        self.entry_title = tk.Entry(self.editor_container, bg=self.bg_color, fg=self.fg_color, insertbackground=self.fg_color, bd=1, relief="solid", font=self.font_normal)
        self.entry_title.pack(fill="x", ipady=4, pady=(0, 10))

        # Artist Field
        lbl_artist = tk.Label(self.editor_container, text="ARTIST", fg="#8a9aa3", bg="#252529", font=self.font_small_bold, anchor="w")
        lbl_artist.pack(fill="x", pady=(5, 2))
        self.entry_artist = tk.Entry(self.editor_container, bg=self.bg_color, fg=self.fg_color, insertbackground=self.fg_color, bd=1, relief="solid", font=self.font_normal)
        self.entry_artist.pack(fill="x", ipady=4, pady=(0, 10))

        # Album Field
        lbl_album = tk.Label(self.editor_container, text="ALBUM", fg="#8a9aa3", bg="#252529", font=self.font_small_bold, anchor="w")
        lbl_album.pack(fill="x", pady=(5, 2))
        self.entry_album = tk.Entry(self.editor_container, bg=self.bg_color, fg=self.fg_color, insertbackground=self.fg_color, bd=1, relief="solid", font=self.font_normal)
        self.entry_album.pack(fill="x", ipady=4, pady=(0, 10))

        # Rating Stars Field
        lbl_rating = tk.Label(self.editor_container, text="RATING", fg="#8a9aa3", bg="#252529", font=self.font_small_bold, anchor="w")
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
                font=self.font_stars,
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
            font=self.font_italic,
            command=self.clear_rating
        )
        self.btn_clear_rating.pack(side="left", padx=15)

        # Separator for Playback Section
        sep = ttk.Separator(self.editor_container, orient="horizontal")
        sep.pack(fill="x", pady=10)

        # Playback Section
        lbl_playback = tk.Label(self.editor_container, text="TEST PLAYBACK", fg="#8a9aa3", bg="#252529", font=self.font_small_bold, anchor="w")
        lbl_playback.pack(fill="x", pady=(0, 5))

        # Progress Bar Canvas
        self.progress_canvas = tk.Canvas(
            self.editor_container,
            height=20,
            bg="#252529",
            highlightthickness=0,
            cursor="hand2"
        )
        self.progress_canvas.pack(fill="x", pady=(0, 10))
        self.progress_canvas.bind("<Configure>", self.draw_progress)
        self.progress_canvas.bind("<Button-1>", self.on_progress_click)
        self.progress_canvas.bind("<B1-Motion>", self.on_progress_click)

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
            font=self.font_bold,
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
            font=self.font_bold,
            command=self.seek_forward_15
        )
        self.btn_seek.pack(side="left", padx=(0, 15))

        self.lbl_time = tk.Label(
            self.playback_frame,
            text="00:00 / 00:00",
            fg=self.fg_color,
            bg="#252529",
            font=self.font_normal
        )
        self.lbl_time.pack(side="left")

        # Add both panels to pane
        main_pane.add(left_frame, minsize=250, stretch="always")
        main_pane.add(self.right_frame, minsize=400, stretch="always")

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

        # Clear and insert into Treeview
        self.files_tree.delete(*self.files_tree.get_children())
        for rel_path, _, rating in self.mp3_files:
            self.files_tree.insert("", tk.END, values=(rel_path, self.format_stars(rating)))

        self.selected_file_path = None
        self.confirm_delete_going_forward = True
        self.stop_playback()
        self.editor_container.pack_forget()
        self.placeholder_label.pack(expand=True)
        self.btn_sync_backup.config(state="normal")

    def on_file_selected(self, event):
        selection = self.files_tree.selection()
        if not selection:
            return
        
        item_id = selection[0]
        idx = self.files_tree.index(item_id)
        _, self.selected_file_path, _ = self.mp3_files[idx]
        
        self.placeholder_label.pack_forget()
        self.editor_container.pack(fill="both", expand=True)

        self.stop_playback()
        self.load_metadata(self.selected_file_path)

        if self.auto_play_var.get():
            self.toggle_play()

    def load_metadata(self, filepath):
        try:
            audio = MP3(filepath, ID3=ID3)
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
        self.draw_progress()

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
                self.playback.seek(0)
            self.playback.play()
            self.btn_play.config(text="⏸ Pause", bg=self.accent_color)

    def seek_forward_15(self):
        if not self.playback:
            return
        new_pos = min(self.playback.duration, max(0.0, self.playback.curr_pos) + 15.0)
        self.playback.seek(new_pos)
        self.update_time_label()
        self.draw_progress()

    def stop_playback(self):
        if self.playback:
            try:
                self.playback.stop()
            except Exception:
                pass
            self.btn_play.config(text="▶ Play", bg=self.btn_bg)
            self.update_time_label()
            self.draw_progress()

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
                self.draw_progress()
                if self.playback.curr_pos >= self.playback.duration - 0.1:
                    self.stop_playback()
            elif self.btn_play.cget("text") == "⏸ Pause":
                self.stop_playback()
        self.root.after(200, self.update_playback_loop)

    def draw_progress(self, event=None):
        if not hasattr(self, 'progress_canvas'):
            return
        self.progress_canvas.delete("all")
        width = self.progress_canvas.winfo_width()
        height = self.progress_canvas.winfo_height()
        
        # Center vertical coordinate
        y = height // 2
        
        # Draw background track
        track_bg = "#404040"
        self.progress_canvas.create_line(10, y, width - 10, y, fill=track_bg, width=4, capstyle="round")
        
        # Calculate progress ratio
        if self.playback and self.playback.duration:
            ratio = max(0.0, min(1.0, self.playback.curr_pos / self.playback.duration))
        else:
            ratio = 0.0
            
        progress_x = 10 + ratio * (width - 20)
        
        # Draw active progress line
        if ratio > 0:
            self.progress_canvas.create_line(10, y, progress_x, y, fill=self.accent_color, width=4, capstyle="round")
            
        # Draw progress circle handle
        r = 6  # Radius of the circle
        self.progress_canvas.create_oval(
            progress_x - r, y - r, progress_x + r, y + r,
            fill="#ffffff", outline=self.accent_color, width=2
        )

    def on_progress_click(self, event):
        if not self.playback or not self.playback.duration:
            return
        width = self.progress_canvas.winfo_width()
        x = max(10, min(width - 10, event.x))
        ratio = (x - 10) / (width - 20)
        target_pos = ratio * self.playback.duration
        self.playback.seek(target_pos)
        self.update_time_label()
        self.draw_progress()

    def select_next_song_and_play(self):
        children = self.files_tree.get_children()
        if not children:
            return
        selection = self.files_tree.selection()
        if not selection:
            return
        
        current_id = selection[0]
        current_idx = self.files_tree.index(current_id)
        next_idx = current_idx + 1
        if next_idx < len(children):
            next_id = children[next_idx]
            self.files_tree.selection_set(next_id)
            self.files_tree.see(next_id)
            if not self.playback or not self.playback.playing:
                self.toggle_play()

    def save_metadata(self):
        if not self.selected_file_path:
            return

        try:
            # Release file handle on Windows before writing tags
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

            audio.save(v2_version=3)

            # Re-initialize/load playback since we released it
            if DEPENDENCIES_AVAILABLE:
                try:
                    self.playback = Playback()
                    self.playback.load_file(self.selected_file_path)
                except Exception as e:
                     print("Warning: Could not re-initialize audio device:", e)
            
            # Update rating in mp3_files and treeview
            for i, (rel_path, path, rating) in enumerate(self.mp3_files):
                if path == self.selected_file_path:
                    self.mp3_files[i] = (rel_path, path, self.selected_rating)
                    item_id = self.files_tree.get_children()[i]
                    self.files_tree.item(item_id, values=(rel_path, self.format_stars(self.selected_rating)))
                    break

            if not self.silent_mode_var.get():
                messagebox.showinfo("Success", "Metadata saved successfully!")

            self.select_next_song_and_play()
        except Exception as e:
            # Re-initialize playback on failure
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

        if not self.silent_mode_var.get():
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

        # Find the index of the deleted song before removing it
        filepath_deleted = self.selected_file_path
        deleted_idx = -1
        for idx, item in enumerate(self.mp3_files):
            if item[1] == filepath_deleted:
                deleted_idx = idx
                break

        # Remove from local list
        self.mp3_files = [item for item in self.mp3_files if item[1] != filepath_deleted]

        # Refresh Treeview
        self.files_tree.delete(*self.files_tree.get_children())
        for rel_path, _, rating in self.mp3_files:
            self.files_tree.insert("", tk.END, values=(rel_path, self.format_stars(rating)))

        # Automatically select the next song if available
        if deleted_idx != -1 and len(self.mp3_files) > 0:
            next_idx = min(deleted_idx, len(self.mp3_files) - 1)
            next_item_id = self.files_tree.get_children()[next_idx]
            self.files_tree.selection_set(next_item_id)
            self.files_tree.see(next_item_id)
        else:
            # Clear selection and view if no files are left
            self.selected_file_path = None
            self.editor_container.pack_forget()
            self.placeholder_label.pack(expand=True)
        
        if not self.silent_mode_var.get():
            messagebox.showinfo("Deleted", "File deleted successfully.", parent=self.root)

    def on_close(self):
        self.stop_playback()
        self.root.destroy()

    def sync_from_backup(self):
        if not self.current_folder:
            return

        json_path = filedialog.askopenfilename(
            title="Choose Library Backup JSON",
            filetypes=[("JSON Files", "*.json"), ("All Files", "*.*")]
        )
        if not json_path:
            return

        try:
            with open(json_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            messagebox.showerror("Error", f"Failed to read JSON backup file:\n{e}", parent=self.root)
            return

        if not isinstance(data, dict) or "tracks" not in data:
            messagebox.showerror("Error", "Invalid backup JSON: 'tracks' array not found.", parent=self.root)
            return

        backup_tracks = data["tracks"]
        
        # Build lookup tables
        backup_by_filename = {}
        backup_by_title_artist = {}
        
        for t in backup_tracks:
            filename = t.get("filename")
            if filename:
                basename = os.path.basename(filename).lower()
                backup_by_filename[basename] = t
            title = t.get("title")
            artist = t.get("artist")
            if title:
                key = (title.strip().lower(), (artist or "").strip().lower())
                backup_by_title_artist[key] = t

        # Compare loaded files with backup
        diff_list = []
        
        for rel_path, full_path, current_rating in self.mp3_files:
            try:
                audio = MP3(full_path, ID3=ID3)
                if audio.tags is None:
                    audio.add_tags()
                tags = audio.tags
            except Exception:
                continue

            current_title = str(tags.get("TIT2", "")).strip()
            current_artist = str(tags.get("TPE1", "")).strip()

            # Find matching backup track
            matched_track = None
            
            basename = os.path.basename(full_path).lower()
            if basename in backup_by_filename:
                matched_track = backup_by_filename[basename]
            
            if not matched_track:
                rel_lower = rel_path.replace("\\", "/").lower()
                for t in backup_tracks:
                    t_filename = t.get("filename")
                    if t_filename and t_filename.replace("\\", "/").lower() == rel_lower:
                        matched_track = t
                        break

            if not matched_track and current_title:
                key = (current_title.lower(), current_artist.lower())
                if key in backup_by_title_artist:
                    matched_track = backup_by_title_artist[key]

            if matched_track:
                backup_title = matched_track.get("title", "").strip()
                backup_artist = matched_track.get("artist", "").strip()
                backup_rating = matched_track.get("qualityRating", 0)

                # Compare rating
                if current_rating != backup_rating:
                    diff_list.append({
                        "filepath": full_path,
                        "rel_path": rel_path,
                        "field": "rating",
                        "old_val": current_rating,
                        "new_val": backup_rating
                    })

                # Compare Title
                if backup_title and current_title != backup_title:
                    diff_list.append({
                        "filepath": full_path,
                        "rel_path": rel_path,
                        "field": "title",
                        "old_val": current_title,
                        "new_val": backup_title
                    })

                # Compare Artist
                if backup_artist and current_artist != backup_artist:
                    diff_list.append({
                        "filepath": full_path,
                        "rel_path": rel_path,
                        "field": "artist",
                        "old_val": current_artist,
                        "new_val": backup_artist
                    })

        if not diff_list:
            messagebox.showinfo("No Differences", "No metadata differences found between loaded files and backup JSON.", parent=self.root)
            return

        SyncDialog(self.root, diff_list, self.apply_metadata_sync)

    def apply_metadata_sync(self, selected_diffs):
        changes_by_file = {}
        for diff in selected_diffs:
            filepath = diff["filepath"]
            if filepath not in changes_by_file:
                changes_by_file[filepath] = []
            changes_by_file[filepath].append(diff)

        success_count = 0
        error_files = []

        self.stop_playback()
        self.playback = None

        for filepath, diffs in changes_by_file.items():
            try:
                audio = MP3(filepath, ID3=ID3)
                if audio.tags is None:
                    audio.add_tags()
                tags = audio.tags

                for diff in diffs:
                    field = diff["field"]
                    val = diff["new_val"]
                    
                    if field == "title":
                        tags["TIT2"] = TIT2(encoding=3, text=[str(val).strip()])
                    elif field == "artist":
                        tags["TPE1"] = TPE1(encoding=3, text=[str(val).strip()])
                    elif field == "rating":
                        email_key = "Windows Media Player 9 Series"
                        if val == 0:
                            tags.delall("POPM")
                        else:
                            rating_bytes = {1: 1, 2: 64, 3: 128, 4: 196, 5: 255}
                            tags.setall("POPM", [POPM(email=email_key, rating=rating_bytes[val])])

                audio.save(v2_version=3)
                success_count += len(diffs)
            except Exception as e:
                error_files.append((os.path.basename(filepath), str(e)))

        self.refresh_mp3_ratings_after_sync()

        if DEPENDENCIES_AVAILABLE:
            try:
                self.playback = Playback()
            except Exception:
                pass

        if self.selected_file_path:
            self.load_metadata(self.selected_file_path)

        msg = f"Successfully synced {success_count} change(s)."
        if error_files:
            msg += "\n\nErrors occurred on following files:\n" + "\n".join(f"- {f}: {err}" for f, err in error_files)
            messagebox.showerror("Sync Results", msg, parent=self.root)
        else:
            messagebox.showinfo("Sync Success", msg, parent=self.root)

    def refresh_mp3_ratings_after_sync(self):
        for i, (rel_path, path, old_rating) in enumerate(self.mp3_files):
            new_rating = self.get_file_rating(path)
            self.mp3_files[i] = (rel_path, path, new_rating)

        self.files_tree.delete(*self.files_tree.get_children())
        for rel_path, _, rating in self.mp3_files:
            self.files_tree.insert("", tk.END, values=(rel_path, self.format_stars(rating)))


class SyncDialog(tk.Toplevel):
    def __init__(self, parent, diff_list, on_sync):
        super().__init__(parent)
        self.title("Metadata Difference Sync Preview")
        self.geometry("800x500")
        self.transient(parent)
        self.grab_set()
        
        self.diff_list = diff_list
        self.on_sync = on_sync
        self.vars = {}

        self.configure(bg="#1e1e24")
        
        lbl_title = tk.Label(
            self,
            text="Confirm Metadata Changes from Backup JSON",
            font=("Arial", 12, "bold"),
            bg="#1e1e24",
            fg="#ffffff"
        )
        lbl_title.pack(pady=10)

        lbl_desc = tk.Label(
            self,
            text="The following differences were found between your local MP3 files and the backup library JSON.\nSelect the changes you want to write back to the files.",
            font=("Arial", 9),
            bg="#1e1e24",
            fg="#8a9aa3",
            justify="left"
        )
        lbl_desc.pack(padx=15, pady=(0, 10), fill="x")

        frame_table = tk.Frame(self, bg="#1e1e24")
        frame_table.pack(fill="both", expand=True, padx=15, pady=5)

        scrollbar = tk.Scrollbar(frame_table, orient="vertical")
        scrollbar.pack(side="right", fill="y")

        self.canvas = tk.Canvas(frame_table, bg="#121214", highlightthickness=0)
        self.canvas.pack(side="left", fill="both", expand=True)
        scrollbar.config(command=self.canvas.yview)
        self.canvas.config(yscrollcommand=scrollbar.set)

        self.scroll_frame = tk.Frame(self.canvas, bg="#121214")
        self.canvas_window = self.canvas.create_window((0, 0), window=self.scroll_frame, anchor="nw")

        self.scroll_frame.bind("<Configure>", self.on_frame_configure)
        self.canvas.bind("<Configure>", self.on_canvas_configure)

        headers = ["Sync", "File Name", "Field", "Current (File)", "New (Backup)"]
        widths = [50, 250, 80, 150, 150]
        
        header_frame = tk.Frame(self.scroll_frame, bg="#2d2d30")
        header_frame.pack(fill="x", ipady=4)
        
        for text, width in zip(headers, widths):
            lbl = tk.Label(header_frame, text=text, fg="#ffffff", bg="#2d2d30", font=("Arial", 9, "bold"), width=width//8, anchor="w" if text != "Sync" else "center")
            lbl.pack(side="left", padx=5)

        for idx, diff in enumerate(self.diff_list):
            row_frame = tk.Frame(self.scroll_frame, bg="#121214", bd=1, relief="flat")
            row_frame.pack(fill="x", ipady=2)
            
            var = tk.BooleanVar(value=True)
            self.vars[idx] = var
            chk = tk.Checkbutton(row_frame, variable=var, bg="#121214", activebackground="#121214", selectcolor="#252529")
            chk.pack(side="left", padx=(10, 5))
            
            lbl_file = tk.Label(row_frame, text=diff["rel_path"], fg="#ffffff", bg="#121214", font=("Arial", 9), width=250//8, anchor="w")
            lbl_file.pack(side="left", padx=5)
            
            lbl_field = tk.Label(row_frame, text=diff["field"].upper(), fg="#8a9aa3", bg="#121214", font=("Arial", 9, "bold"), width=80//8, anchor="w")
            lbl_field.pack(side="left", padx=5)
            
            old_str = "★" * diff["old_val"] + "☆" * (5 - diff["old_val"]) if diff["field"] == "rating" else str(diff["old_val"])
            lbl_old = tk.Label(row_frame, text=old_str, fg="#e53935", bg="#121214", font=("Arial", 9), width=150//8, anchor="w")
            lbl_old.pack(side="left", padx=5)
            
            new_str = "★" * diff["new_val"] + "☆" * (5 - diff["new_val"]) if diff["field"] == "rating" else str(diff["new_val"])
            lbl_new = tk.Label(row_frame, text=new_str, fg="#00b06b", bg="#121214", font=("Arial", 9), width=150//8, anchor="w")
            lbl_new.pack(side="left", padx=5)

        btn_frame = tk.Frame(self, bg="#1e1e24", pady=15)
        btn_frame.pack(fill="x", side="bottom")

        btn_sync = tk.Button(
            btn_frame,
            text="🔄 Sync Selected Changes",
            bg="#00b06b",
            fg="#ffffff",
            activebackground="#008a52",
            activeforeground="#ffffff",
            bd=0,
            padx=20,
            pady=10,
            font=("Arial", 10, "bold"),
            command=self.sync_selected
        )
        btn_sync.pack(side="right", padx=(10, 20))

        btn_cancel = tk.Button(
            btn_frame,
            text="Cancel",
            bg="#2d2d30",
            fg="#ffffff",
            activebackground="#3e3e42",
            activeforeground="#ffffff",
            bd=0,
            padx=20,
            pady=10,
            font=("Arial", 10, "bold"),
            command=self.destroy
        )
        btn_cancel.pack(side="right")

    def on_frame_configure(self, event):
        self.canvas.configure(scrollregion=self.canvas.bbox("all"))

    def on_canvas_configure(self, event):
        self.canvas.itemconfig(self.canvas_window, width=event.width)

    def sync_selected(self):
        selected_diffs = [self.diff_list[idx] for idx, var in self.vars.items() if var.get()]
        if not selected_diffs:
            messagebox.showinfo("No Selection", "No changes selected for sync.", parent=self)
            return
        self.on_sync(selected_diffs)
        self.destroy()


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
