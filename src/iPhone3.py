import os
import asyncio
from pathlib import Path
from mutagen.easyid3 import EasyID3
from pymobiledevice3.lockdown import create_using_usbmux
from pymobiledevice3.services.afc import AfcService

LOCAL_TARGET_DIR = Path("./iPod_Extracted_Music")
LOCAL_TARGET_DIR.mkdir(exist_ok=True)

async def extract_music():
    print("Connecting to your iPhone 3...")
    try:
        # FIX 1: Await the async connection factory
        lockdown = await create_using_usbmux()
        
        # FIX 2: Use 'async with' for the asynchronous service context
        async with AfcService(lockdown) as afc:
            remote_music_path = "iTunes_Control/Music"
            
            # Fetch remote directory list
            try:
                folders = afc.listdir(remote_music_path)
            except Exception as e:
                print(f"Could not read root music folder: {e}")
                return
                
            # Traverse the Fxx directories on the iPhone
            for f_folder in folders:
                remote_f_path = f"{remote_music_path}/{f_folder}"
                
                # Check if it's a valid directory structure
                try:
                    files = afc.listdir(remote_f_path)
                except Exception:
                    continue # Skip files/system links that aren't directories
                    
                for filename in files:
                    remote_file_path = f"{remote_f_path}/{filename}"
                    local_file_path = LOCAL_TARGET_DIR / filename
                    
                    print(f"Downloading: {filename}")
                    
                    # Pull raw file contents down over USB
                    try:
                        file_bytes = afc.get_file_contents(remote_file_path)
                        with open(local_file_path, "wb") as local_f:
                            local_f.write(file_bytes)
                    except Exception as download_error:
                        print(f" ! Failed to download {filename}: {download_error}")
                        continue
                    
                    # Parse metadata and rename to a human-readable format
                    try:
                        audio = EasyID3(local_file_path)
                        title = audio.get("title", ["Unknown Title"])[0].replace("/", "-").strip()
                        artist = audio.get("artist", ["Unknown Artist"])[0].replace("/", "-").strip()
                        
                        # Handle potential empty strings or missing tags gracefully
                        if not title: title = "Unknown Title"
                        if not artist: artist = "Unknown Artist"
                        
                        # Preserve original file extension (.mp3, .m4a, etc.)
                        ext = Path(filename).suffix
                        new_name = LOCAL_TARGET_DIR / f"{artist} - {title}{ext}"
                        
                        # Avoid collisions if identical track titles exist
                        counter = 1
                        while new_name.exists():
                            new_name = LOCAL_TARGET_DIR / f"{artist} - {title} ({counter}){ext}"
                            counter += 1
                            
                        os.rename(local_file_path, new_name)
                        print(f" Successfully organized: {artist} - {title}")
                    except Exception:
                        print(f" ! Could not read ID3 tags for {filename}, kept original name.")
                        
    except Exception as e:
        print(f"Error communicating with legacy device: {e}")
        print("Ensure iTunes/Apple Mobile Device Support is installed so the USB mux daemon is running.")

# Entry point to execute the asynchronous event loop
if __name__ == "__main__":
    asyncio.run(extract_music())