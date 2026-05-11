using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;

namespace WgcCapture;

// ---------------------------------------------------------------------------
// COM interop: IGraphicsCaptureItemInterop
// Not projected by CsWinRT — declared by hand; obtained via QI on the
// WinRT activation factory for GraphicsCaptureItem.
// ---------------------------------------------------------------------------

[ComImport]
[Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IGraphicsCaptureItemInterop
{
    nint CreateForWindow(nint window, ref Guid iid);
}

// ---------------------------------------------------------------------------
// WinRT / D3D11 bootstrapping
// ---------------------------------------------------------------------------

internal static class WinRtInterop
{
    // HSTRING is a pointer-sized handle.
    [DllImport("combase.dll", CharSet = CharSet.Unicode, ExactSpelling = true, PreserveSig = false)]
    private static extern void WindowsCreateString(string sourceString, int length, out nint hstring);

    [DllImport("combase.dll", ExactSpelling = true, PreserveSig = false)]
    private static extern void WindowsDeleteString(nint hstring);

    [DllImport("combase.dll", ExactSpelling = true)]
    private static extern int RoGetActivationFactory(nint activatableClassId, ref Guid iid, out nint factory);

    private static readonly Guid IID_IUnknown = new("00000000-0000-0000-C000-000000000046");

    /// <summary>
    /// Calls RoGetActivationFactory for <paramref name="runtimeClass"/> and returns
    /// the factory pointer as a raw COM pointer (caller must Release).
    /// </summary>
    internal static nint GetActivationFactory(string runtimeClass)
    {
        WindowsCreateString(runtimeClass, runtimeClass.Length, out nint hstring);
        try
        {
            Guid iid = IID_IUnknown;
            int hr = RoGetActivationFactory(hstring, ref iid, out nint factory);
            if (hr < 0)
            {
                Marshal.ThrowExceptionForHR(hr);
            }

            return factory;
        }
        finally
        {
            WindowsDeleteString(hstring);
        }
    }
}

internal static class D3D11Interop
{
    [DllImport("d3d11.dll", ExactSpelling = true, PreserveSig = false)]
    private static extern void D3D11CreateDevice(
        nint pAdapter,
        uint DriverType,          // D3D_DRIVER_TYPE_HARDWARE = 1
        nint Software,
        uint Flags,               // D3D11_CREATE_DEVICE_BGRA_SUPPORT = 0x20
        nint pFeatureLevels,
        uint FeatureLevels,
        uint SDKVersion,          // D3D11_SDK_VERSION = 7
        out nint ppDevice,
        nint pFeatureLevel,
        nint ppImmediateContext);

    [DllImport("windows.graphics.directx.direct3d11.interop.dll", ExactSpelling = true, PreserveSig = false)]
    private static extern void CreateDirect3D11DeviceFromDXGIDevice(
        nint dxgiDevice,
        out nint graphicsDevice);

    private static readonly Guid IID_IDXGIDevice = new("54ec77fa-1377-44e6-8c32-88fd5f44c84c");

    internal static IDirect3DDevice CreateDirect3DDevice()
    {
        D3D11CreateDevice(
            pAdapter: 0,
            DriverType: 1,   // HARDWARE
            Software: 0,
            Flags: 0x20,     // BGRA_SUPPORT
            pFeatureLevels: 0,
            FeatureLevels: 0,
            SDKVersion: 7,
            out nint d3dDevice,
            pFeatureLevel: 0,
            ppImmediateContext: 0);

        try
        {
            Guid iidDxgi = IID_IDXGIDevice;
            int hr = Marshal.QueryInterface(d3dDevice, ref iidDxgi, out nint dxgiDevice);
            if (hr < 0)
            {
                Marshal.ThrowExceptionForHR(hr);
            }

            try
            {
                CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice, out nint inspectable);
                try
                {
                    return WinRT.MarshalInterface<IDirect3DDevice>.FromAbi(inspectable);
                }
                finally
                {
                    Marshal.Release(inspectable);
                }
            }
            finally
            {
                Marshal.Release(dxgiDevice);
            }
        }
        finally
        {
            Marshal.Release(d3dDevice);
        }
    }
}

// ---------------------------------------------------------------------------
// Win32 window enumeration
// ---------------------------------------------------------------------------

internal static class WindowFinder
{
    private delegate bool EnumWindowsProc(nint hwnd, nint lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, nint lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(nint hwnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(nint hwnd);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(nint hwnd, out RECT lpRect);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(nint hObject);

    [DllImport("kernel32.dll")]
    private static extern bool Process32First(nint hSnapshot, ref PROCESSENTRY32 lppe);

    [DllImport("kernel32.dll")]
    private static extern bool Process32Next(nint hSnapshot, ref PROCESSENTRY32 lppe);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left, Top, Right, Bottom;
        public int Area => Math.Abs((Right - Left) * (Bottom - Top));
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public nint th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    private const uint TH32CS_SNAPPROCESS = 0x00000002;

    private static HashSet<uint> GetChildPids(uint parentPid)
    {
        var children = new HashSet<uint>();
        nint snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == -1)
        {
            return children;
        }

        try
        {
            var entry = new PROCESSENTRY32 { dwSize = (uint)Marshal.SizeOf<PROCESSENTRY32>() };
            if (Process32First(snapshot, ref entry))
            {
                do
                {
                    if (entry.th32ParentProcessID == parentPid)
                    {
                        children.Add(entry.th32ProcessID);
                    }
                }
                while (Process32Next(snapshot, ref entry));
            }
        }
        finally
        {
            CloseHandle(snapshot);
        }

        return children;
    }

    internal static nint FindLargestVisibleWindow(int targetPid)
    {
        HashSet<uint> allowedPids = GetChildPids((uint)targetPid);
        allowedPids.Add((uint)targetPid);

        nint bestHwnd = 0;
        int bestArea = 0;

        EnumWindows((hwnd, _) =>
        {
            if (!IsWindowVisible(hwnd))
            {
                return true;
            }

            GetWindowThreadProcessId(hwnd, out uint windowPid);
            if (!allowedPids.Contains(windowPid))
            {
                return true;
            }

            GetWindowRect(hwnd, out RECT rect);
            int area = rect.Area;
            if (area > bestArea)
            {
                bestArea = area;
                bestHwnd = hwnd;
            }

            return true;
        }, 0);

        return bestHwnd;
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

internal static class Program
{
    [STAThread]
    internal static int Main(string[] args)
    {
        if (!TryParseArgs(args, out int pid, out string fullPath, out string thumbPath, out string parseError))
        {
            Console.Error.WriteLine($"usage error: {parseError}");
            Console.Error.WriteLine("usage: wgc-capture --pid <int> --full <path> --thumb <path>");
            return 2;
        }

        try
        {
            RunCapture(pid, fullPath, thumbPath).GetAwaiter().GetResult();
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(FormatError(ex));
            return 1;
        }
    }

    private static async Task RunCapture(int pid, string fullPath, string thumbPath)
    {
        nint hwnd = WindowFinder.FindLargestVisibleWindow(pid);
        if (hwnd == 0)
        {
            throw new InvalidOperationException($"no top-level window found for PID {pid}");
        }

        IDirect3DDevice d3dDevice = D3D11Interop.CreateDirect3DDevice();
        Direct3D11CaptureFramePool? framePool = null;
        GraphicsCaptureSession? session = null;

        try
        {
            GraphicsCaptureItem item = CreateCaptureItemForWindow(hwnd);

            var tcs = new TaskCompletionSource<SoftwareBitmap>(TaskCreationOptions.RunContinuationsAsynchronously);

            framePool = Direct3D11CaptureFramePool.CreateFreeThreaded(
                d3dDevice,
                DirectXPixelFormat.B8G8R8A8UIntNormalized,
                2,
                item.Size);

            framePool.FrameArrived += async (pool, _) =>
            {
                if (tcs.Task.IsCompleted)
                {
                    return;
                }

                using Direct3D11CaptureFrame? frame = pool.TryGetNextFrame();
                if (frame is null)
                {
                    return;
                }

                try
                {
                    SoftwareBitmap bmp = await SoftwareBitmap.CreateCopyFromSurfaceAsync(
                        frame.Surface,
                        BitmapAlphaMode.Premultiplied);
                    tcs.TrySetResult(bmp);
                }
                catch (Exception ex)
                {
                    tcs.TrySetException(ex);
                }
            };

            session = framePool.CreateCaptureSession(item);
            session.IsCursorCaptureEnabled = false;
            session.StartCapture();

            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            cts.Token.Register(() => tcs.TrySetException(
                new TimeoutException("no frame arrived within 3 s — window may be minimised or off-screen")));

            SoftwareBitmap rawBitmap = await tcs.Task;

            // Normalise to BitmapAlphaMode.Ignore for stable PNG encoding.
            // When conversion is skipped, sourceBitmap == rawBitmap; only one Dispose needed.
            SoftwareBitmap sourceBitmap = rawBitmap.BitmapAlphaMode != BitmapAlphaMode.Ignore
                ? SoftwareBitmap.Convert(rawBitmap, BitmapPixelFormat.Bgra8, BitmapAlphaMode.Ignore)
                : rawBitmap;

            try
            {
                await EncodeResizedPng(sourceBitmap, fullPath, 1568);
                await EncodeResizedPng(sourceBitmap, thumbPath, 256);
            }
            finally
            {
                if (!ReferenceEquals(sourceBitmap, rawBitmap))
                {
                    rawBitmap.Dispose();
                }

                sourceBitmap.Dispose();
            }
        }
        finally
        {
            session?.Dispose();
            framePool?.Dispose();
            (d3dDevice as IDisposable)?.Dispose();
        }
    }

    // IID of IGraphicsCaptureItemInterop (COM-only factory interop interface).
    private static readonly Guid IID_IGraphicsCaptureItemInterop =
        new("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356");

    // IID of IGraphicsCaptureItem (the default WinRT interface on the item object).
    // CreateForWindow's riid argument specifies which interface to return.
    private static readonly Guid IID_IGraphicsCaptureItem =
        new("79C3F95B-31F7-4EC2-A464-632EF5D30760");

    private static GraphicsCaptureItem CreateCaptureItemForWindow(nint hwnd)
    {
        // Get the raw activation factory for GraphicsCaptureItem via combase,
        // then QI for IGraphicsCaptureItemInterop (COM-only, not WinRT-projected).
        nint factory = WinRtInterop.GetActivationFactory(
            "Windows.Graphics.Capture.GraphicsCaptureItem");
        try
        {
            Guid iidInterop = IID_IGraphicsCaptureItemInterop;
            int hr = Marshal.QueryInterface(factory, ref iidInterop, out nint interopPtr);
            if (hr < 0)
            {
                Marshal.ThrowExceptionForHR(hr);
            }

            try
            {
                var interop = (IGraphicsCaptureItemInterop)Marshal.GetObjectForIUnknown(interopPtr);
                Guid iid = IID_IGraphicsCaptureItem;
                nint itemPtr = interop.CreateForWindow(hwnd, ref iid);
                return GraphicsCaptureItem.FromAbi(itemPtr);
            }
            finally
            {
                Marshal.Release(interopPtr);
            }
        }
        finally
        {
            Marshal.Release(factory);
        }
    }

    private static async Task EncodeResizedPng(SoftwareBitmap source, string outputPath, int longEdge)
    {
        (uint scaledW, uint scaledH) = ComputeScaledDimensions(
            (uint)source.PixelWidth, (uint)source.PixelHeight, (uint)longEdge);

        string? dir = Path.GetDirectoryName(outputPath);
        if (!string.IsNullOrEmpty(dir))
        {
            Directory.CreateDirectory(dir);
        }

        using var stream = new InMemoryRandomAccessStream();

        BitmapEncoder encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, stream);
        encoder.SetSoftwareBitmap(source);
        encoder.BitmapTransform.ScaledWidth = scaledW;
        encoder.BitmapTransform.ScaledHeight = scaledH;
        encoder.BitmapTransform.InterpolationMode = BitmapInterpolationMode.Fant;
        encoder.IsThumbnailGenerated = false;
        await encoder.FlushAsync();

        stream.Seek(0);
        using IInputStream inputStream = stream.GetInputStreamAt(0);
        var reader = new DataReader(inputStream);
        await reader.LoadAsync((uint)stream.Size);
        byte[] bytes = new byte[stream.Size];
        reader.ReadBytes(bytes);

        await File.WriteAllBytesAsync(outputPath, bytes);
    }

    private static (uint width, uint height) ComputeScaledDimensions(uint w, uint h, uint maxLongEdge)
    {
        if (w == 0 || h == 0)
        {
            return (w, h);
        }

        uint longEdge = Math.Max(w, h);
        if (longEdge <= maxLongEdge)
        {
            return (w, h);
        }

        double scale = (double)maxLongEdge / longEdge;
        return ((uint)Math.Round(w * scale), (uint)Math.Round(h * scale));
    }

    private static string FormatError(Exception ex)
    {
        int hr = ex.HResult;
        return hr switch
        {
            unchecked((int)0x80010108) => "WGC unavailable on this system (RPC_E_DISCONNECTED)",
            unchecked((int)0x80004005) => "window not capturable (E_FAIL — transparent or no GraphicsCaptureItem?)",
            _ => ex.Message,
        };
    }

    private static bool TryParseArgs(
        string[] args,
        out int pid,
        out string fullPath,
        out string thumbPath,
        out string error)
    {
        pid = 0;
        fullPath = "";
        thumbPath = "";
        error = "";

        for (int i = 0; i < args.Length - 1; i++)
        {
            switch (args[i])
            {
                case "--pid":
                    if (!int.TryParse(args[i + 1], out pid))
                    {
                        error = $"--pid must be an integer, got '{args[i + 1]}'";
                        return false;
                    }

                    i++;
                    break;
                case "--full":
                    fullPath = args[i + 1];
                    i++;
                    break;
                case "--thumb":
                    thumbPath = args[i + 1];
                    i++;
                    break;
            }
        }

        if (pid == 0)
        {
            error = "--pid is required";
            return false;
        }

        if (string.IsNullOrWhiteSpace(fullPath))
        {
            error = "--full is required";
            return false;
        }

        if (string.IsNullOrWhiteSpace(thumbPath))
        {
            error = "--thumb is required";
            return false;
        }

        return true;
    }
}
