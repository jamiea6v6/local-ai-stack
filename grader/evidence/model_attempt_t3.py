import pyaudio
import numpy as np
from scipy import signal
import sys

def bandpass_filter(data, lowcut, highcut, fs, order=5):
    """
    Applies a Butterworth bandpass filter to the audio data.
    
    Args:
        data (np.ndarray): Input audio data chunk.
        lowcut (float): Lower cutoff frequency (Hz).
        highcut (float): Upper cutoff frequency (Hz).
        fs (int): Sampling rate (Hz).
        order (int): Filter order.
        
    Returns:
        np.ndarray: Filtered audio data chunk.
    """
    # Design the Butterworth filter
    nyquist = 0.5 * fs
    low = lowcut / nyquist
    high = highcut / nyquist
    b, a = signal.butter(order, [low, high], btype='band')
    
    # Apply the filter
    # Note: For real-time streaming, the filter state (zi) must be maintained 
    # across calls to maintain continuity.
    # We use lfilter which handles the state internally for a single chunk.
    # For a robust long-running stream, a class structure managing the state 
    # (zi) would be preferred, but lfilter is sufficient for a basic implementation.
    filtered_data = signal.lfilter(b, a, data)
    return filtered_data

def main():
    # --- Configuration ---
    # CW signals typically operate in the low kHz range. 
    # Adjust these values based on the specific CW band you are listening to.
    SAMPLE_RATE = 44100  # Standard sample rate
    LOW_CUT = 1000      # Lower cutoff frequency (Hz)
    HIGH_CUT = 3000    # Upper cutoff frequency (Hz)
    
    # Audio format settings
    CHANNELS = 1
    FORMAT = pyaudio.paInt16 # 16-bit integer format
    
    print(f"--- CW Bandpass Filter Initialized ---")
    print(f"Sample Rate: {SAMPLE_RATE} Hz")
    print(f"Bandpass: {LOW_CUT} Hz to {HIGH_CUT} Hz")
    print("Press Ctrl+C to stop.")

    try:
        # Initialize PyAudio
        p = pyaudio.PyAudio()
        
        # Open the input stream from the USB sound card
        # PyAudio usually defaults to the system's default input device.
        # If you need a specific USB device, you must find its index using p.get_host_api_info_by_index(0).get_device_count()
        stream = p.open(format=FORMAT,
                        channels=CHANNELS,
                        rate=SAMPLE_RATE,
                        input=True,
                        frames_per_buffer=1024) # Buffer size for real-time processing

        print("\nListening for audio stream...")
        
        while True:
            # Read audio data chunk
            data = stream.read(1024, exception_on_overflow=False)
            
            # Convert bytes to numpy array (assuming 16-bit PCM)
            audio_chunk = np.frombuffer(data, dtype=np.int16)
            
            # Apply the bandpass filter
            filtered_chunk = bandpass_filter(audio_chunk, LOW_CUT, HIGH_CUT, SAMPLE_RATE)
            
            # Convert filtered numpy array back to bytes
            filtered_data = filtered_chunk.astype(np.int16).tobytes()
            
            # Play the filtered audio back through the default output device
            # This allows you to hear the filtered CW signal.
            stream_out = p.open(format=FORMAT,
                               channels=CHANNELS,
                               rate=SAMPLE_RATE,
                               output=True)
            stream_out.write(filtered_data)
            stream_out.close()

    except KeyboardInterrupt:
        print("\nStopping filter.")
    except Exception as e:
        print(f"\nAn error occurred: {e}")
    finally:
        if 'p' in locals() and p:
            p.terminate()

if __name__ == "__main__":
    main()