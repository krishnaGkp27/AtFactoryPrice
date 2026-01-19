import React, { useState, useEffect } from 'react';
import { Camera, Plus, Edit, Trash2, Upload, Save, X, LogOut, LogIn, Package } from 'lucide-react';

// YOUR ACTUAL CONFIGURATION
const CONFIG = {
  firebase: {
    apiKey: "AIzaSyA3SzcQWEgWv51hA5CsNyj6WG1cp-sZYKA",
    authDomain: "atfactoryprice-6ba8f.firebaseapp.com",
    projectId: "atfactoryprice-6ba8f",
    storageBucket: "atfactoryprice-6ba8f.firebasestorage.app",
    messagingSenderId: "660895645396",
    appId: "1:660895645396:web:a4ea1e8febc6e0b7f74541"
  },
  cloudinary: {
    cloudName: "dpxwuty0f",
    uploadPreset: "atfactoryprice_products"
  }
};

const AdminPanel = () => {
  const [user, setUser] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState({});
  const [showProductForm, setShowProductForm] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);
  const [uploadingImage, setUploadingImage] = useState(false);

  const [productForm, setProductForm] = useState({
    name: '',
    price: '',
    description: '',
    cloudinaryId: '',
    category: { level1: '', level2: '', level3: '' }
  });

  useEffect(() => {
    loadProducts();
    loadCategories();
  }, []);

  const loadProducts = () => {
    try {
      const stored = localStorage.getItem('afp_products');
      if (stored) {
        setProducts(JSON.parse(stored));
      } else {
        const sampleProducts = [
          {
            id: Date.now().toString(),
            name: 'Premium Senator Material - Navy Blue',
            price: '15000',
            description: 'High-quality senator material perfect for traditional wear. Rich navy blue color.',
            cloudinaryId: 'sample/senator-navy',
            category: { level1: 'fabric', level2: 'mens', level3: 'senator' }
          }
        ];
        setProducts(sampleProducts);
        localStorage.setItem('afp_products', JSON.stringify(sampleProducts));
      }
    } catch (error) {
      console.error('Error loading products:', error);
    }
  };

  const loadCategories = () => {
    const defaultCategories = {
      fabric: {
        name: 'Fabric',
        subcategories: {
          mens: { name: 'Mens Fabric', types: { senator: 'Senator Material', cashmere: 'Cashmere' } },
          womens: { name: 'Womens Fabric', types: { silk: 'Silk', lace: 'Lace' } },
          uniform: { name: 'Uniform Fabric', types: { chinos: 'Chinos', gaberdine: 'Gaberdine' } }
        }
      },
      garments: {
        name: 'Garments',
        subcategories: {
          mens: { name: 'Mens Garments', types: { tshirt: 'T-Shirts', shirt: 'Shirts' } },
          womens: { name: 'Womens Garments', types: { gown: 'Gowns', kaftan: 'Kaftans' } },
          kids: { name: 'Kids Garments', types: { tshirt: 'T-Shirts', pants: 'Pants' } }
        }
      }
    };
    setCategories(defaultCategories);
  };

  const handleLogin = (e) => {
    e.preventDefault();
    setLoading(true);
    
    setTimeout(() => {
      if (email && password) {
        setUser({ email, uid: 'admin-123' });
        setLoading(false);
      } else {
        alert('Please enter email and password');
        setLoading(false);
      }
    }, 500);
  };

  const handleLogout = () => {
    setUser(null);
    setEmail('');
    setPassword('');
  };

  // REAL CLOUDINARY UPLOAD - PRODUCTION READY
  const handleImageUpload = async (file) => {
    if (!file) return;

    setUploadingImage(true);

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('upload_preset', CONFIG.cloudinary.uploadPreset);
      formData.append('folder', 'products');

      const response = await fetch(
        `https://api.cloudinary.com/v1_1/${CONFIG.cloudinary.cloudName}/image/upload`,
        {
          method: 'POST',
          body: formData
        }
      );

      if (!response.ok) {
        throw new Error('Upload failed');
      }

      const data = await response.json();
      
      setProductForm({ ...productForm, cloudinaryId: data.public_id });
      alert('✅ Image uploaded successfully to Cloudinary!');
      
    } catch (error) {
      console.error('Error uploading to Cloudinary:', error);
      alert('❌ Error uploading image. Please check your Cloudinary settings and try again.');
    } finally {
      setUploadingImage(false);
    }
  };

  const handleSaveProduct = () => {
    if (!productForm.name || !productForm.price || !productForm.description) {
      alert('Please fill in all required fields');
      return;
    }

    setLoading(true);

    try {
      let updatedProducts;
      
      if (editingProduct) {
        updatedProducts = products.map(p => 
          p.id === editingProduct.id ? { ...productForm, id: p.id } : p
        );
      } else {
        const newProduct = {
          ...productForm,
          id: Date.now().toString()
        };
        updatedProducts = [...products, newProduct];
      }

      localStorage.setItem('afp_products', JSON.stringify(updatedProducts));
      setProducts(updatedProducts);

      setProductForm({
        name: '',
        price: '',
        description: '',
        cloudinaryId: '',
        category: { level1: '', level2: '', level3: '' }
      });
      setEditingProduct(null);
      setShowProductForm(false);
      
      alert(editingProduct ? '✅ Product updated successfully!' : '✅ Product added successfully!');
    } catch (error) {
      console.error('Error saving product:', error);
      alert('Error saving product. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleEditProduct = (product) => {
    setEditingProduct(product);
    setProductForm(product);
    setShowProductForm(true);
  };

  const handleDeleteProduct = (productId) => {
    if (!confirm('Are you sure you want to delete this product?')) return;

    setLoading(true);
    try {
      const updatedProducts = products.filter(p => p.id !== productId);
      localStorage.setItem('afp_products', JSON.stringify(updatedProducts));
      setProducts(updatedProducts);
      alert('Product deleted successfully!');
    } catch (error) {
      console.error('Error deleting product:', error);
      alert('Error deleting product. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const getImageUrl = (cloudinaryId) => {
    if (!cloudinaryId) return 'https://via.placeholder.com/200?text=No+Image';
    return `https://res.cloudinary.com/${CONFIG.cloudinary.cloudName}/image/upload/w_200,q_auto,f_auto/${cloudinaryId}`;
  };

  if (!user) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 to-gray-800 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md">
          <div className="text-center mb-8">
            <div className="bg-black text-white w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
              <LogIn className="w-8 h-8" />
            </div>
            <h1 className="text-3xl font-bold text-gray-900 mb-2">Admin Login</h1>
            <p className="text-gray-600">AtFactoryPrice Management</p>
          </div>
          
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-2">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-black focus:outline-none transition"
                placeholder="admin@atfactoryprice.com"
              />
            </div>
            
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-2">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-black focus:outline-none transition"
                placeholder="••••••••"
              />
            </div>
            
            <button
              onClick={handleLogin}
              disabled={loading}
              className="w-full bg-black text-white py-3 rounded-lg font-semibold hover:bg-gray-800 transition disabled:opacity-50"
            >
              {loading ? 'Logging in...' : 'Login to Dashboard'}
            </button>
          </div>
          
          <div className="mt-6 p-4 bg-blue-50 rounded-lg">
            <p className="text-sm text-blue-800">
              <strong>Demo Mode:</strong> Enter any email and password to test. For production, enable Firebase Auth.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="bg-black text-white w-12 h-12 rounded-full flex items-center justify-center">
                <Package className="w-6 h-6" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">AtFactoryPrice Admin</h1>
                <p className="text-sm text-gray-600">Product Management System</p>
              </div>
            </div>
            
            <div className="flex items-center gap-4">
              <span className="text-sm text-gray-600">{user.email}</span>
              <button
                onClick={handleLogout}
                className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition"
              >
                <LogOut className="w-4 h-4" />
                Logout
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="bg-white rounded-xl shadow-md p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-600 text-sm font-medium">Total Products</p>
                <p className="text-3xl font-bold text-gray-900 mt-1">{products.length}</p>
              </div>
              <div className="bg-blue-100 p-3 rounded-lg">
                <Package className="w-8 h-8 text-blue-600" />
              </div>
            </div>
          </div>
          
          <div className="bg-white rounded-xl shadow-md p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-600 text-sm font-medium">Categories</p>
                <p className="text-3xl font-bold text-gray-900 mt-1">{Object.keys(categories).length}</p>
              </div>
              <div className="bg-green-100 p-3 rounded-lg">
                <Camera className="w-8 h-8 text-green-600" />
              </div>
            </div>
          </div>
          
          <div className="bg-white rounded-xl shadow-md p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-600 text-sm font-medium">With Images</p>
                <p className="text-3xl font-bold text-gray-900 mt-1">
                  {products.filter(p => p.cloudinaryId).length}
                </p>
              </div>
              <div className="bg-purple-100 p-3 rounded-lg">
                <Camera className="w-8 h-8 text-purple-600" />
              </div>
            </div>
          </div>
        </div>

        <div className="mb-6">
          <button
            onClick={() => {
              setShowProductForm(true);
              setEditingProduct(null);
              setProductForm({
                name: '',
                price: '',
                description: '',
                cloudinaryId: '',
                category: { level1: '', level2: '', level3: '' }
              });
            }}
            className="flex items-center gap-2 px-6 py-3 bg-black text-white rounded-lg hover:bg-gray-800 transition font-semibold"
          >
            <Plus className="w-5 h-5" />
            Add New Product
          </button>
        </div>

        {showProductForm && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50 overflow-y-auto">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl my-8">
              <div className="bg-white border-b px-6 py-4 flex items-center justify-between rounded-t-2xl">
                <h2 className="text-2xl font-bold text-gray-900">
                  {editingProduct ? 'Edit Product' : 'Add New Product'}
                </h2>
                <button
                  onClick={() => setShowProductForm(false)}
                  className="text-gray-500 hover:text-gray-700"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>
              
              <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">
                    Product Image
                  </label>
                  <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center">
                    {productForm.cloudinaryId ? (
                      <div className="space-y-4">
                        <img
                          src={getImageUrl(productForm.cloudinaryId)}
                          alt="Preview"
                          className="mx-auto rounded-lg max-h-48"
                        />
                        <button
                          onClick={() => setProductForm({ ...productForm, cloudinaryId: '' })}
                          className="text-red-600 hover:text-red-700 text-sm font-medium"
                        >
                          Remove Image
                        </button>
                      </div>
                    ) : (
                      <div>
                        <Upload className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                        <p className="text-gray-600 mb-4">Upload product image to Cloudinary</p>
                        <input
                          type="file"
                          accept="image/*"
                          onChange={(e) => handleImageUpload(e.target.files[0])}
                          className="hidden"
                          id="imageUpload"
                        />
                        <label
                          htmlFor="imageUpload"
                          className="inline-block px-4 py-2 bg-black text-white rounded-lg cursor-pointer hover:bg-gray-800 transition"
                        >
                          {uploadingImage ? 'Uploading to Cloudinary...' : 'Choose Image'}
                        </label>
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">
                    Product Name *
                  </label>
                  <input
                    type="text"
                    value={productForm.name}
                    onChange={(e) => setProductForm({ ...productForm, name: e.target.value })}
                    className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-black focus:outline-none transition"
                    placeholder="e.g., Premium Senator Material - Navy Blue"
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">
                    Price (₦) *
                  </label>
                  <input
                    type="number"
                    value={productForm.price}
                    onChange={(e) => setProductForm({ ...productForm, price: e.target.value })}
                    className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-black focus:outline-none transition"
                    placeholder="15000"
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">
                    Description *
                  </label>
                  <textarea
                    value={productForm.description}
                    onChange={(e) => setProductForm({ ...productForm, description: e.target.value })}
                    rows="4"
                    className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-black focus:outline-none transition resize-none"
                    placeholder="Detailed product description..."
                  />
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-2">
                      Main Category
                    </label>
                    <select
                      value={productForm.category.level1}
                      onChange={(e) => setProductForm({
                        ...productForm,
                        category: { ...productForm.category, level1: e.target.value, level2: '', level3: '' }
                      })}
                      className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-black focus:outline-none transition"
                    >
                      <option value="">Select</option>
                      {Object.keys(categories).map(key => (
                        <option key={key} value={key}>{categories[key].name}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-2">
                      Subcategory
                    </label>
                    <select
                      value={productForm.category.level2}
                      onChange={(e) => setProductForm({
                        ...productForm,
                        category: { ...productForm.category, level2: e.target.value, level3: '' }
                      })}
                      disabled={!productForm.category.level1}
                      className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-black focus:outline-none transition disabled:opacity-50"
                    >
                      <option value="">Select</option>
                      {productForm.category.level1 && categories[productForm.category.level1]?.subcategories &&
                        Object.keys(categories[productForm.category.level1].subcategories).map(key => (
                          <option key={key} value={key}>
                            {categories[productForm.category.level1].subcategories[key].name}
                          </option>
                        ))
                      }
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-2">
                      Type
                    </label>
                    <select
                      value={productForm.category.level3}
                      onChange={(e) => setProductForm({
                        ...productForm,
                        category: { ...productForm.category, level3: e.target.value }
                      })}
                      disabled={!productForm.category.level2}
                      className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-black focus:outline-none transition disabled:opacity-50"
                    >
                      <option value="">Select</option>
                      {productForm.category.level1 && productForm.category.level2 &&
                        categories[productForm.category.level1]?.subcategories[productForm.category.level2]?.types &&
                        Object.entries(categories[productForm.category.level1].subcategories[productForm.category.level2].types).map(([key, value]) => (
                          <option key={key} value={key}>{value}</option>
                        ))
                      }
                    </select>
                  </div>
                </div>

                <div className="flex gap-4 pt-4">
                  <button
                    onClick={handleSaveProduct}
                    disabled={loading}
                    className="flex-1 flex items-center justify-center gap-2 px-6 py-3 bg-black text-white rounded-lg hover:bg-gray-800 transition font-semibold disabled:opacity-50"
                  >
                    <Save className="w-5 h-5" />
                    {loading ? 'Saving...' : (editingProduct ? 'Update Product' : 'Add Product')}
                  </button>
                  <button
                    onClick={() => setShowProductForm(false)}
                    className="px-6 py-3 border-2 border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition font-semibold"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="bg-white rounded-xl shadow-md overflow-hidden">
          <div className="px-6 py-4 border-b">
            <h2 className="text-xl font-bold text-gray-900">Products ({products.length})</h2>
          </div>
          
          <div className="overflow-x-auto">
            {products.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                <Package className="w-16 h-16 mx-auto mb-4 opacity-30" />
                <p className="text-lg font-medium">No products yet</p>
                <p className="text-sm mt-2">Click "Add New Product" to get started</p>
              </div>
            ) : (
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Image</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Product</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Price</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Category</th>
                    <th className="px-6 py-3 text-right text-xs font-semibold text-gray-600 uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {products.map(product => (
                    <tr key={product.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4">
                        <img
                          src={getImageUrl(product.cloudinaryId)}
                          alt={product.name}
                          className="w-16 h-16 rounded-lg object-cover"
                        />
                      </td>
                      <td className="px-6 py-4">
                        <p className="font-semibold text-gray-900">{product.name}</p>
                        <p className="text-sm text-gray-500 mt-1">{product.description.substring(0, 60)}...</p>
                      </td>
                      <td className="px-6 py-4">
                        <p className="font-semibold text-gray-900">₦{parseFloat(product.price).toFixed(2)}</p>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex flex-wrap gap-1">
                          {product.category.level1 && (
                            <span className="px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded">
                              {categories[product.category.level1]?.name}
                            </span>
                          )}
                          {product.category.level2 && (
                            <span className="px-2 py-1 bg-green-100 text-green-800 text-xs rounded">
                              {categories[product.category.level1]?.subcategories[product.category.level2]?.name}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => handleEditProduct(product)}
                            className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition"
                            title="Edit"
                          >
                            <Edit className="w-5 h-5" />
                          </button>
                          <button
                            onClick={() => handleDeleteProduct(product.id)}
                            className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition"
                            title="Delete"
                          >
                            <Trash2 className="w-5 h-5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="mt-8 bg-gradient-to-r from-green-50 to-blue-50 rounded-xl p-6 border border-green-200">
          <h3 className="text-lg font-bold text-gray-900 mb-4">✅ System Status</h3>
          <div className="space-y-3 text-sm text-gray-700">
            <p><strong>✅ Cloudinary:</strong> ACTIVE - Real image uploads enabled (Cloud: {CONFIG.cloudinary.cloudName})</p>
            <p><strong>⚠️ Firebase Auth:</strong> Demo mode - Replace handleLogin with real Firebase auth</p>
            <p><strong>📦 Storage:</strong> LocalStorage (switch to Firestore for production)</p>
            <p className="pt-2 text-xs text-gray-500">Next step: Enable Firebase Authentication for secure admin access</p>
          </div>
        </div>
      </main>
    </div>
  );
};

export default AdminPanel;