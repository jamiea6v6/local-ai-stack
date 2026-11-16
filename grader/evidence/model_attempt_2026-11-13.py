import sys
import argparse
import numpy as np
import pyaudio
from scipy import signal

def bandpass_filter(data, lowcut, highcut, fs, order=5):
    """
    Applies a Butterworth band-pass filter to the audio data.
    """
    # Normalize the cutoff frequencies
    nyquist = 0.5 * fs
    low = lowcut / nyquist
    high = highcut / nyquist
    
    # Design the filter
    b, a = signal.butter(order, [low, high], btype='band')
    
    # Apply the filter
    # We use lfilter for real-time processing of chunks
    filtered_data = signal.lfilter(b, a, data)
    return filtered_data

def audio_stream_processor(input_device_index, output_device_index, sample_rate, chunk_size, low_cut, high_cut, order):
    """
    Captures audio from the input device, applies filtering, and plays it through the output device.
    """
    print(f"--- Starting Audio Stream Processor ---")
    print(f"Sample Rate: {sample_rate} Hz")
    print(f"Input Device Index: {input_device_index}")
    print(f"Output Device Index: {output_device_index}")
    print(f"Filter Range: {low_cut} Hz to {high_cut} Hz")
    print(f"Chunk Size: {chunk_size} frames")
    print("-" * 35)

    p = pyaudio.PyAudio()

    try:
        # Open input stream (USB sound card)
        input_stream = p.open(format=p.get_format_from_width(2), # Assuming 16-bit audio
                               channels=1, # Mono input for simplicity
                               rate=sample_rate,
                               input=True,
                               frames_per_buffer=chunk_size,
                               input_device_index=input_device_index)
        
        # Open output stream (Speakers/Headphones)
        output_stream = p.open(format=p.get_format_from_width(2),
                               channels=1,
                               rate=sample_rate,
                               output=True,
                               frames_per_buffer=chunk_size,
                               output_device_index=output_device_index)

        print("Streaming started. Press Ctrl+C to stop.")
        
        while True:
            # Read audio data from the input stream
            input_data = input_stream.read(chunk_size, exception_on_overflow=False)
            
            # Convert bytes to numpy array (float format for processing)
            # Assuming 16-bit PCM data
            audio_chunk = np.frombuffer(input_data, dtype=np.int16).astype(np.float32)
            
            # Apply the band-pass filter
            filtered_chunk = bandpass_filter(audio_chunk, low_cut, high_cut, sample_rate, order)
            
            # Convert back to 16-bit integer format for output
            # Scale back to the original range and clip
            output_data = (filtered_chunk * 32767).astype(np.int16)
            
            # Write filtered audio data to the output stream
            output_stream.write(output_data.tobytes())

    except KeyboardInterrupt:
        print("\nStopping audio stream processor...")
    except Exception as e:
        print(f"\nAn error occurred: {e}", file=sys.stderr)
    finally:
        # Clean up resources
        if 'input_stream' in locals() and input_stream:
            input_stream.stop_stream()
            input_stream.close()
        if 'output_stream' in locals() and output_stream:
            output_stream.stop_stream()
            output_stream.close()
        p.terminate()
        print("Cleanup complete. Exiting.")

def main():
    parser = argparse.ArgumentParser(
        description="Real-time Band-Pass Audio Filter for CW Listening.",
        formatter_class=argparse.RawTextHelpFormatter
    )
    
    # Required arguments
    parser.add_argument('--sample-rate', type=int, default=44100, help="Audio sample rate (Hz). Default: 44100")
    parser.add_argument('--chunk-size', type=int, default=1024, help="Number of frames to process per chunk. Default: 1024")
    parser.add_argument('--low-cut', type=float, default=3000.0, help="Lower cutoff frequency (Hz). Default: 3000.0")
    parser.add_argument('--high-cut', type=float, default=10000.0, help="Upper cutoff frequency (Hz). Default: 10000.0")
    parser.add_argument('--order', type=int, default=5, help="Filter order (higher = sharper cutoff). Default: 5")

    # Device selection (requires user to know device indices)
    parser.add_argument('--input-device', type=int, required=True, help="Index of the USB sound card (Input).")
    parser.add_argument('--output-device', type=int, required=True, help="Index of the speakers/headphones (Output).")

    args = parser.parse_args()

    audio_stream_processor(
        input_device_index=args.input_device,
        output_device_index=args.output_device,
        sample_rate=args.sample_rate,
        chunk_size=args.chunk_size,
        low_cut=args.low_cut,
        high_cut=args.high_cut,
        order=args.order
    )

if __name__ == "__main__":
    main()