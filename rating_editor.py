import os
import sys
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

# Ensure mutagen is installed, otherwise prompt the user with instructions
try:
    from mutagen.id3 import ID3, TALB, TIT2, TPE1, POPM
    from mutagen.mp3 import MP3
    MUTAGEN_AVAILABLE = True
except ImportError:
    MUTAGEN_AVAILABLE = False


class RatingEditorApp:
    def __init__(self, root):
        self.root = root
        self.root.title("DancePlayer Audio Rating Editor")
        self.root.geometry("800x550")
        self.root.minsize(700, 450)

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

        # If mutagen is not available, show a prominent warning screen
        if not MUTAGEN_AVAILABLE:
            self.show_missing_dependency_screen()
            return

        self.build_ui()

    def show_missing_dependency_screen(self):
        frame = tk.Frame(self.root, bg=self.bg_color)
        frame.pack(expand=True, fill="both", padx=40, pady=40)

        label_title = tk.Label(
            frame, 
            text="Dependency Missing: mutagen", 
            fg="#e53935", 
            bg=self.bg_color, 
            font=("Arial", 16, "bold")
        )
        label_title.pack(pady=20)

        label_desc = tk.Label(
            frame, 
            text="This helper app requires the 'mutagen' library to read and write audio file tags.\n\n"
                 "Please run the following command in your terminal/cmd to install it:", 
            fg=self.fg_color, 
            bg=self.bg_color, 
            font=("Arial", 11)
        )
        label_desc.pack(pady=10)

        cmd_entry = tk.Entry(frame, font=("Courier", 12), width=30, justify="center")
        cmd_entry.insert(0, "pip install mutagen")
        cmd_entry.configure(state="readonly")
        cmd_entry.pack(pady=10)

        btn_retry = ttk.Button(frame, text="I installed it, try again!", command=self.restart_app)
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
        self.entry_album.pack(fill="x", ipady=4, pady=(0, 15))

        # Rating Stars Field
        lbl_rating = tk.Label(self.editor_container, text="RATING", fg="#8a9aa3", bg="#252529", font=("Arial", 8, "bold"), anchor="w")
        lbl_rating.pack(fill="x", pady=(5, 2))
        
        self.stars_frame = tk.Frame(self.editor_container, bg="#252529")
        self.stars_frame.pack(fill="x", pady=(0, 20))
        self.star_labels = []
        for star_idx in range(1, 6):
            lbl_star = tk.Label(
                self.stars_frame,
                text="☆",
                fg=self.star_color,
                bg="#252529",
                font=("Arial", 22, "bold"),
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

        # Action Buttons row
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
        self.btn_save.pack(side="left", padx=10)

        # Add both frames to pane
        main_pane.add(left_frame, minsize=200, stretch="always")
        main_pane.add(self.right_frame, minsize=350, stretch="always")

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
                    self.mp3_files.append((rel_path, full_path))

        self.files_listbox.delete(0, tk.END)
        for rel_path, _ in self.mp3_files:
            self.files_listbox.insert(tk.END, rel_path)

        self.selected_file_path = None
        self.editor_container.pack_forget()
        self.placeholder_label.pack(expand=True)

    def on_file_selected(self, event):
        selection = self.files_listbox.curselection()
        if not selection:
            return
        
        idx = selection[0]
        _, self.selected_file_path = self.mp3_files[idx]
        
        self.placeholder_label.pack_forget()
        self.editor_container.pack(fill="both", expand=True)

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

    def set_rating_stars(self, count):
        self.selected_rating = count
        for i, lbl in enumerate(self.star_labels):
            if i < count:
                lbl.config(text="★")
            else:
                lbl.config(text="☆")

    def clear_rating(self):
        self.set_rating_stars(0)

    def save_metadata(self):
        if not self.selected_file_path:
            return

        try:
            audio = MP3(self.selected_file_path, ID3=ID3)
            if audio.tags is None:
                audio.add_tags()
            tags = audio.tags

            # Save basic texts
            tags["TIT2"] = TIT2(encoding=3, text=[self.entry_title.get().strip()])
            tags["TPE1"] = TPE1(encoding=3, text=[self.entry_artist.get().strip()])
            tags["TALB"] = TALB(encoding=3, text=[self.entry_album.get().strip()])

            # Save POPM Rating (Popularimeter) mapped to Windows/macOS values
            # POPM expects email key and rating byte
            email_key = "Windows Media Player 9 Series"
            if self.selected_rating == 0:
                tags.delall("POPM")
            else:
                rating_bytes = {
                    1: 1,      # mapped POPM rating values
                    2: 64,
                    3: 128,
                    4: 196,
                    5: 255
                }
                tags.setall("POPM", [POPM(email=email_key, rating=rating_bytes[self.selected_rating])])

            audio.save()
            messagebox.showinfo("Success", "Metadata saved successfully!")
        except Exception as e:
            messagebox.showerror("Error", f"Failed to save metadata: {e}")


if __name__ == "__main__":
    root = tk.Tk()
    app = RatingEditorApp(root)
    root.mainloop()
